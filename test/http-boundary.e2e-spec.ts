import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Res,
  HttpCode,
  UseInterceptors,
  UseGuards,
  UnauthorizedException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { FileInterceptor } from '@nestjs/platform-express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Exclude, Expose, Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { configureHttp } from '../src/http/configure-http';
import { ProblemException } from '../src/http/problem';
import {
  MultipartOnlyGuard,
  allowedOrder,
  multipartBoolean,
  multipartVersion,
  PaginationQuery,
} from '../src/http/parsing';
import {
  parseRuntimeConfig,
  RUNTIME_CONFIG,
} from '../src/runtime/runtime.config';

class JsonInput {
  @IsString()
  @Length(1, 80)
  name: string;
}
class MultipartInput {
  @Transform(({ value }) => multipartVersion(value))
  @IsInt()
  @Min(0)
  expectedVersion: number;

  @IsOptional()
  @Transform(({ value }) => multipartBoolean(value))
  removePhoto?: boolean;
}
@Exclude()
class PublicResult {
  @Expose() name: string;
  passwordHash = 'private-response-marker';
  constructor(name: string) {
    this.name = name;
  }
}
// Fixtures exist only in this testing module; production has no task-004 business routes.
@Controller('boundary')
class BoundaryController {
  @Post('json') json(@Body() body: JsonInput) {
    return new PublicResult(body.name);
  }
  @Get('page') page(@Query() query: PaginationQuery) {
    return { page: query.page, pageSize: query.pageSize };
  }
  @Post('multipart')
  @UseGuards(MultipartOnlyGuard)
  @UseInterceptors(FileInterceptor('photo'))
  multipart(@Body() body: MultipartInput) {
    return {
      expectedVersion: body.expectedVersion,
      removePhoto: body.removePhoto,
    };
  }
  @Post('empty') @HttpCode(204) empty() {
    return { discarded: true };
  }
  @Get('binary') binary(@Res() response: Response) {
    response.type('image/jpeg').send(Buffer.from([0xff, 0xd8, 0xff]));
  }
  @Get('partial')
  partial(@Res() response: Response) {
    response.type('image/jpeg');
    response.write(Buffer.from([0xff]));
    throw new Error('private-stream-marker');
  }
  @Post('unauthorized') unauthorized() {
    throw new UnauthorizedException('private-auth-marker');
  }
  @Post('forbidden') forbidden() {
    throw new ForbiddenException('private-role-marker');
  }
  @Post('in-progress')
  inProgress() {
    throw new ProblemException(
      409,
      'OPERATION_IN_PROGRESS',
      'Operation in progress',
      { retryAfter: 1 },
    );
  }
  @Post('conflict') conflict() {
    throw new ProblemException(409, 'VERSION_CONFLICT', 'Version conflict', {
      details: { expectedVersion: 1, actualVersion: 2 },
    });
  }
  @Post('rate') rate() {
    throw new ProblemException(429, 'RATE_LIMITED', 'Too many requests', {
      retryAfter: 30,
    });
  }
  @Post('unexpected') unexpected() {
    throw new Error(
      'SELECT password FROM employees; /private/root private-error-marker',
    );
  }
}

describe('shared production HTTP setup', () => {
  let app: NestExpressApplication;
  let storage: string;
  const base = '/api/v1/boundary';
  const id = '55555555-5555-4555-8555-555555555555';
  beforeAll(async () => {
    storage = await mkdtemp(join(tmpdir(), 'wfh-http-'));
    const config = parseRuntimeConfig({
      NODE_ENV: 'test',
      DB_HOST: '127.0.0.1',
      DB_NAME: 'unused_test',
      DB_USERNAME: 'unused',
      DB_PASSWORD: 'unused',
      JWT_SECRET: 'test-only-http-secret-at-least-32-bytes',
      JWT_ISSUER: 'test',
      JWT_AUDIENCE: 'test',
      STORAGE_ROOT: storage,
      CORS_ORIGINS: 'https://cors.example',
      CSRF_TRUSTED_ORIGINS: 'https://csrf.example',
      MAX_FILE_BYTES: '32',
    });
    const module = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [BoundaryController],
    })
      .overrideProvider(getDataSourceToken())
      .useValue({ isInitialized: false })
      .overrideProvider(RUNTIME_CONFIG)
      .useValue(config)
      .compile();
    app = module.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    configureHttp(app, config);
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    await rm(storage, { recursive: true, force: true });
  });

  it('uses the API prefix, validates JSON and serializes only exposed DTO fields', async () => {
    await request(app.getHttpServer())
      .post('/boundary/json')
      .send({ name: 'ok' })
      .expect(404);
    const response = await request(app.getHttpServer())
      .post(base + '/json')
      .set('X-Request-Id', id)
      .send({ name: 'ok' })
      .expect(201);
    expect(response.body).toEqual({ name: 'ok' });
    expect(response.headers['x-request-id']).toBe(id);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
    const invalid = await request(app.getHttpServer())
      .post(base + '/json')
      .send({ name: 9, password: 'private-input-marker' })
      .expect(400);
    expect(invalid.headers['content-type']).toMatch(
      /^application\/problem\+json/,
    );
    expect(invalid.body.code).toBe('VALIDATION_FAILED');
    expect(
      invalid.body.errors.map((error: { field: string }) => error.field).sort(),
    ).toEqual(['name', 'password']);
    expect(JSON.stringify(invalid.body)).not.toContain('private-input-marker');
    const transport = await request(app.getHttpServer())
      .post(base + '/json')
      .type('form')
      .send({ name: 'ok' })
      .expect(415);
    expect(transport.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('sanitizes malformed JSON, unknown routes/query secrets, and replaces invalid request IDs', async () => {
    const malformed = await request(app.getHttpServer())
      .post(base + '/json')
      .set('Content-Type', 'application/json')
      .set('X-Request-Id', 'invalid-private-marker')
      .send('{"password":"private-json-marker",')
      .expect(400);
    expect(malformed.body.code).toBe('INVALID_REQUEST');
    expect(JSON.stringify(malformed.body)).not.toMatch(
      /private-json-marker|invalid-private-marker/,
    );
    expect(malformed.headers['x-request-id']).toBe(malformed.body.requestId);
    const missing = await request(app.getHttpServer())
      .get('/missing?password=private-query-marker')
      .expect(404);
    expect(JSON.stringify(missing.body)).not.toContain('private-query-marker');
    expect(missing.body.code).toBe('NOT_FOUND');
    expect(missing.headers['content-type']).toMatch(
      /^application\/problem\+json/,
    );
    for (const path of ['/', '/api/v1', '/api/v1/']) {
      const prefixRoot = await request(app.getHttpServer())
        .get(path)
        .expect(404);
      expect(prefixRoot.body.code).toBe('NOT_FOUND');
    }
  });

  it('bounds JSON body size before controller validation', async () => {
    const response = await request(app.getHttpServer())
      .post(base + '/json')
      .send({ name: 'a'.repeat(1024 * 1024) })
      .expect(413);
    expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('uses built-in CSRF for JSON and multipart with Problem headers and no route exclusions', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const response = await request(app.getHttpServer())
        .post(base + '/json')
        .set('Origin', 'https://evil.example')
        .set('Sec-Fetch-Site', site)
        .send({ name: 'ok' })
        .expect(403);
      expect(response.body.code).toBe('CSRF_ORIGIN_REJECTED');
      expect(response.headers['x-request-id']).toBe(response.body.requestId);
      expect(response.headers['cache-control']).toBe('private, no-store');
    }
    const multipart = await request(app.getHttpServer())
      .post(base + '/multipart')
      .set('Origin', 'https://evil.example')
      .field('expectedVersion', '1')
      .expect(403);
    expect(multipart.body.code).toBe('CSRF_ORIGIN_REJECTED');
    await request(app.getHttpServer())
      .post(base + '/json')
      .set('Origin', 'https://evil.example')
      .set('Content-Type', 'application/json')
      .send('{invalid')
      .expect(403);
    await request(app.getHttpServer())
      .post(base + '/json')
      .set('Origin', 'https://csrf.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ name: 'ok' })
      .expect(201);
    await request(app.getHttpServer())
      .post(base + '/json')
      .set('Sec-Fetch-Site', 'same-origin')
      .send({ name: 'ok' })
      .expect(201);
    await request(app.getHttpServer())
      .post(base + '/json')
      .send({ name: 'ok' })
      .expect(201);
  });

  it('keeps CORS and CSRF allowlists independent and handles preflight', async () => {
    const preflight = await request(app.getHttpServer())
      .options(base + '/json')
      .set('Origin', 'https://cors.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
      .expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(
      'https://cors.example',
    );
    expect(preflight.text).toBe('');
    expect(preflight.headers['x-request-id']).toBeDefined();
    const denied = await request(app.getHttpServer())
      .post(base + '/json')
      .set('Origin', 'https://cors.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ name: 'ok' })
      .expect(403);
    expect(denied.headers['access-control-allow-origin']).toBe(
      'https://cors.example',
    );
    const csrfOnly = await request(app.getHttpServer())
      .post(base + '/json')
      .set('Origin', 'https://csrf.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ name: 'ok' })
      .expect(201);
    expect(csrfOnly.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('uses actual Host rather than untrusted forwarded Host for CSRF fallback', async () => {
    await request(app.getHttpServer())
      .post(base + '/json')
      .set('Host', 'api.example')
      .set('Origin', 'https://api.example')
      .send({ name: 'ok' })
      .expect(201);
    const response = await request(app.getHttpServer())
      .post(base + '/json')
      .set('Host', 'api.example')
      .set('Origin', 'https://evil.example')
      .set('X-Forwarded-Host', 'evil.example')
      .send({ name: 'ok' })
      .expect(403);
    expect(response.body.code).toBe('CSRF_ORIGIN_REJECTED');
  });

  it('parses canonical multipart values and rejects duplicates/undeclared parts', async () => {
    const ok = await request(app.getHttpServer())
      .post(base + '/multipart')
      .field('expectedVersion', '0')
      .field('removePhoto', 'false')
      .expect(201);
    expect(ok.body).toEqual({ expectedVersion: 0, removePhoto: false });
    const wrongTransport = await request(app.getHttpServer())
      .post(base + '/multipart')
      .send({ expectedVersion: '1' })
      .expect(415);
    expect(wrongTransport.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    for (const value of ['01', '1.0', '-1', ' 1', '9007199254740992'])
      await request(app.getHttpServer())
        .post(base + '/multipart')
        .field('expectedVersion', value)
        .expect(400);
    await request(app.getHttpServer())
      .post(base + '/multipart')
      .field('expectedVersion', '1')
      .field('removePhoto', 'yes')
      .expect(400);
    await request(app.getHttpServer())
      .post(base + '/multipart')
      .field('expectedVersion', '1')
      .field('expectedVersion', '2')
      .expect(400);
    await request(app.getHttpServer())
      .post(base + '/multipart')
      .field('expectedVersion', '1')
      .field('other', 'private-marker')
      .expect(400);
    await request(app.getHttpServer())
      .post(base + '/multipart')
      .field('expectedVersion', '1')
      .attach('other', Buffer.from('image'), 'photo.jpg')
      .expect(400);
  });

  it('enforces multipart file/field/part limits', async () => {
    await request(app.getHttpServer())
      .post(base + '/multipart')
      .field('expectedVersion', '1')
      .attach('photo', Buffer.alloc(33), 'photo.jpg')
      .expect(413);
    await request(app.getHttpServer())
      .post(base + '/multipart')
      .field('expectedVersion', '1')
      .attach('photo', Buffer.from('a'), 'a.jpg')
      .attach('photo', Buffer.from('b'), 'b.jpg')
      .expect(400);
    await request(app.getHttpServer())
      .post(base + '/multipart')
      .field('expectedVersion', '1')
      .field('extra', 'a'.repeat(16385))
      .expect(400);
    let fields = request(app.getHttpServer()).post(base + '/multipart');
    for (let i = 0; i < 17; i++) fields = fields.field('field' + i, 'value');
    await fields.expect(400);
  });

  it('bounds pagination, rejects repeated/unknown query values and allows only declared ordering', async () => {
    expect(
      (
        await request(app.getHttpServer())
          .get(base + '/page')
          .expect(200)
      ).body,
    ).toEqual({ page: 1, pageSize: 20 });
    expect(
      (
        await request(app.getHttpServer())
          .get(base + '/page?page=2&pageSize=100')
          .expect(200)
      ).body,
    ).toEqual({ page: 2, pageSize: 100 });
    for (const query of [
      'page=0',
      'page=01',
      'page=1&page=2',
      'pageSize=101',
      'pageSize=1.5',
      'page=9007199254740992',
      'unknown=x',
    ])
      await request(app.getHttpServer())
        .get(base + '/page?' + query)
        .expect(400);
    expect(allowedOrder(undefined, ['name', 'id'], 'name')).toBe('name');
    expect(() =>
      allowedOrder('name; DROP TABLE employees', ['name', 'id'], 'name'),
    ).toThrow(ProblemException);
  });

  it('preserves empty 204 and binary/HEAD responses with common headers', async () => {
    const empty = await request(app.getHttpServer())
      .post(base + '/empty')
      .expect(204);
    expect(empty.text).toBe('');
    const binary = await request(app.getHttpServer())
      .get(base + '/binary')
      .expect(200);
    expect(binary.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(binary.headers['content-length']).toBe('3');
    expect(binary.body).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(binary.headers['cache-control']).toBe('private, no-store');
    const head = await request(app.getHttpServer())
      .head(base + '/binary')
      .expect(200);
    expect(head.text).toBeUndefined();
    expect(head.headers['content-length']).toBe('3');
    await expect(
      request(app.getHttpServer()).get(base + '/partial'),
    ).rejects.toThrow(/aborted|socket hang up/);
  });

  it('maps auth/domain/limit errors and sanitizes unexpected failures and logs', async () => {
    const auth = await request(app.getHttpServer())
      .post(base + '/unauthorized')
      .expect(401);
    expect(auth.headers['www-authenticate']).toBe('Bearer');
    expect(auth.body.code).toBe('AUTHENTICATION_REQUIRED');
    const role = await request(app.getHttpServer())
      .post(base + '/forbidden')
      .expect(403);
    expect(role.body.code).toBe('FORBIDDEN');
    const conflict = await request(app.getHttpServer())
      .post(base + '/conflict')
      .expect(409);
    expect(conflict.body.details).toEqual({
      expectedVersion: 1,
      actualVersion: 2,
    });
    const rate = await request(app.getHttpServer())
      .post(base + '/rate')
      .expect(429);
    expect(rate.headers['retry-after']).toBe('30');
    const pending = await request(app.getHttpServer())
      .post(base + '/in-progress')
      .expect(409);
    expect(pending.headers['retry-after']).toBe('1');
    expect(pending.body.code).toBe('OPERATION_IN_PROGRESS');
    const logging = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      const failed = await request(app.getHttpServer())
        .post(base + '/unexpected')
        .set('Authorization', 'Bearer private-token-marker')
        .expect(500);
      expect(failed.body.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(failed.body)).not.toMatch(
        /SELECT|private|stack|password/,
      );
      expect(JSON.stringify(logging.mock.calls)).not.toMatch(
        /SELECT|private-token-marker|private-error-marker/,
      );
    } finally {
      logging.mockRestore();
    }
  });
});
