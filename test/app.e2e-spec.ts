import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { getDataSourceToken } from '@nestjs/typeorm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureHttp } from '../src/http/configure-http';
import { RUNTIME_CONFIG } from '../src/runtime/runtime.config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Clock } from '../src/runtime/clock';

describe('runtime foundation (e2e)', () => {
  let app: INestApplication<App>;
  let storage: string;
  let originalEnvironment: NodeJS.ProcessEnv;

  beforeEach(async () => {
    storage = await mkdtemp(join(tmpdir(), 'wfh-runtime-e2e-'));
    originalEnvironment = { ...process.env };
    Object.assign(process.env, {
      NODE_ENV: 'test',
      ATTENDANCE_RPC_CREDENTIAL:
        'e2e-only-attendance-credential-at-least-32-bytes',
      DB_HOST: '127.0.0.1',
      DB_NAME: 'absensi_test',
      DB_USERNAME: 'absensi_test',
      DB_PASSWORD: 'test-only-database',
      JWT_SECRET: 'test-only-signing-secret-at-least-32-bytes',
      JWT_ISSUER: 'absensi-test',
      JWT_AUDIENCE: 'absensi-web-test',
      STORAGE_ROOT: storage,
    });
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(getDataSourceToken())
      .useValue({ isInitialized: false })
      .overrideProvider(Clock)
      .useValue({ now: () => new Date('2026-11-07T00:00:00.000Z') })
      .compile();

    app = moduleFixture.createNestApplication();
    configureHttp(
      app as unknown as NestExpressApplication,
      app.get(RUNTIME_CONFIG),
    );
    await app.init();
  });

  it('starts with injectable runtime services with validated auth routes and no bootstrap route', async () => {
    await request(app.getHttpServer()).get('/').expect(404);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({})
      .expect(400);
    expect(app.get(Clock).now().toISOString()).toBe('2026-11-07T00:00:00.000Z');
  });

  afterEach(async () => {
    await app?.close();
    process.env = originalEnvironment;
    await rm(storage, { recursive: true, force: true });
  });
});
