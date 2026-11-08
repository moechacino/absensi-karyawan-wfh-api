import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource, In } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureHttp } from '../src/http/configure-http';
import { loadRuntimeConfig } from '../src/runtime/runtime.config';
import {
  EmployeeEntity,
  DivisionEntity,
  PositionEntity,
  FileObjectEntity,
  ScheduleVersionEntity,
} from '../src/database/entities';
import { insertFixture, prepareTestDatabase } from './mysql-fixture';

describe('authentication HTTP with native MySQL', () => {
  let app: NestExpressApplication;
  let source: DataSource;
  let ids: Awaited<ReturnType<typeof insertFixture>>;
  const initial = 'Fictional-Initial-Password-Only';

  beforeAll(async () => {
    const prepared = await prepareTestDatabase();
    await prepared.destroy();
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    configureHttp(app, loadRuntimeConfig());
    await app.init();
    source = app.get(DataSource);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    ids = await source.transaction(insertFixture);
  });

  afterEach(async () => {
    await source.manager.delete(ScheduleVersionEntity, { id: ids.schedule });
    await source.manager.delete(FileObjectEntity, { id: ids.file });
    await source.manager.delete(EmployeeEntity, {
      id: In([ids.employee, ids.otherEmployee]),
    });
    await source.manager.delete(PositionEntity, { id: ids.position });
    await source.manager.delete(DivisionEntity, { id: ids.division });
  });

  function login(password = initial) {
    return request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ids.employee.toUpperCase() + '@EXAMPLE.TEST', password });
  }

  it('logs in, returns matching /me, and keeps the token valid after client logout', async () => {
    const grant = (await login().expect(200)).body;
    expect(grant.expiresIn).toBe(3600);
    expect(grant.employee.permissions).toEqual(['SELF_SERVICE']);
    expect(grant.employee.hasPasswordChanged).toBe(false);
    expect(grant.employee).not.toHaveProperty('initialPassword');
    const auth = 'Bearer ' + grant.accessToken;
    const profile = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', auth)
      .expect(200);
    expect(profile.body).toEqual(grant.employee);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', auth)
      .expect(204);
    await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', auth)
      .expect(200);
  });

  it('replaces initial plaintext with a hash, accepts the new credential and preserves the old JWT', async () => {
    const grant = (await login().expect(200)).body;
    const password = '😀'.repeat(15);
    await request(app.getHttpServer())
      .post('/api/v1/auth/password')
      .set('Authorization', 'Bearer ' + grant.accessToken)
      .send({
        currentPassword: initial,
        newPassword: password,
        confirmPassword: password,
      })
      .expect(204);
    const employee = await source.manager
      .getRepository(EmployeeEntity)
      .createQueryBuilder('employee')
      .addSelect(['employee.initialPassword', 'employee.passwordHash'])
      .where({ id: ids.employee })
      .getOneOrFail();
    expect(employee.initialPassword).toBeNull();
    expect(employee.passwordHash).toMatch(/^\$argon2id\$/);
    expect(employee.hasPasswordChanged).toBe(true);
    expect(employee.version).toBe(2);
    await login().expect(401);
    await login(password).expect(200);
    const me = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', 'Bearer ' + grant.accessToken)
      .expect(200);
    expect(me.body.hasPasswordChanged).toBe(true);
  });

  it('serializes concurrent changes so the old credential cannot be spent twice', async () => {
    const grant = (await login().expect(200)).body;
    const responses = await Promise.all(
      ['first-password-long', 'second-password-long'].map((password) =>
        request(app.getHttpServer())
          .post('/api/v1/auth/password')
          .set('Authorization', 'Bearer ' + grant.accessToken)
          .send({
            currentPassword: initial,
            newPassword: password,
            confirmPassword: password,
          }),
      ),
    );
    expect(
      responses.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([204, 422]);
    expect(
      responses.find((response) => response.status === 422)?.body.code,
    ).toBe('CURRENT_PASSWORD_INCORRECT');
  });

  it('rejects new login for inactive accounts while issued tokens remain usable', async () => {
    const grant = (await login().expect(200)).body;
    await source.manager.update(
      EmployeeEntity,
      { id: ids.employee },
      { status: 'INACTIVE', role: 'HRD' },
    );
    const denied = await login().expect(401);
    expect(denied.body.code).toBe('INVALID_CREDENTIALS');
    const me = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', 'Bearer ' + grant.accessToken)
      .expect(200);
    expect(me.body.permissions).toEqual(['SELF_SERVICE']);
  });

  it('uses Problem errors, validates DTOs/JSON, and rejects missing or invalid tokens', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Content-Type', 'text/plain')
      .send('hello')
      .expect(415);
    const missing = await request(app.getHttpServer())
      .get('/api/v1/me')
      .expect(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');
    const invalid = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    expect(invalid.body.code).toBe('TOKEN_INVALID');
    expect(invalid.headers['content-type']).toContain(
      'application/problem+json',
    );
  });

  it('throttles repeated login attempts with Retry-After', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await login('wrong').expect(401);
    }

    const response = await login('wrong').expect(429);
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });
});
