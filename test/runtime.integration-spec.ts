import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import { hash, verify, argon2id } from 'argon2';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { prepareTestDatabase } from './mysql-fixture';
import { RUNTIME_CONFIG } from '../src/runtime/runtime.config';
import type { RuntimeConfig } from '../src/runtime/runtime.config';

describe('pinned runtime with real MySQL (explicit integration suite)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const migrated = await prepareTestDatabase();
    await migrated.destroy();
    app = await NestFactory.create(AppModule, {
      logger: false,
      abortOnError: false,
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('starts the migrated application without employee accounts/bootstrap routes', async () => {
    await request(app.getHttpServer()).get('/').expect(404);
    const source = app.get(DataSource);
    const [version] = await source.query(
      'SELECT VERSION() AS version, @@session.time_zone AS timeZone',
    );
    expect(version.version).toMatch(/^8\.4\./);
    expect(version.timeZone).toBe('+00:00');
    expect(source.options.synchronize).toBe(false);
    expect(await source.getRepository('EmployeeEntity').count()).toBe(0);
  });

  it('uses mysql2 transactions and preserves date-only/UTC values', async () => {
    const runner = app.get(DataSource).createQueryRunner();
    await runner.connect();
    try {
      await runner.query(
        'CREATE TEMPORARY TABLE runtime_check (id INT PRIMARY KEY, work_date DATE, instant DATETIME(3)) ENGINE=InnoDB',
      );
      await runner.startTransaction('READ COMMITTED');
      await runner.query('INSERT INTO runtime_check VALUES (1, ?, ?)', [
        '2026-12-31',
        new Date('2026-12-31T16:00:00.123Z'),
      ]);
      await runner.rollbackTransaction();
      expect(await runner.query('SELECT id FROM runtime_check')).toEqual([]);
      await runner.startTransaction('READ COMMITTED');
      await runner.query('INSERT INTO runtime_check VALUES (2, ?, ?)', [
        '2026-12-31',
        new Date('2026-12-31T16:00:00.123Z'),
      ]);
      await runner.commitTransaction();
      const [row] = await runner.query(
        'SELECT work_date AS workDate, instant FROM runtime_check',
      );
      expect(row.workDate).toBe('2026-12-31');
      expect(row.instant.toISOString()).toBe('2026-12-31T16:00:00.123Z');
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.query('DROP TEMPORARY TABLE IF EXISTS runtime_check');
      await runner.release();
    }
  });

  it('loads native Argon2id and signs/verifies a scoped JWT under the pinned module/runtime setup', async () => {
    const config = app.get<RuntimeConfig>(RUNTIME_CONFIG);
    const jwt = new JwtService({ secret: config.jwt.secret });
    const token = await jwt.signAsync(
      { sub: 'runtime-check', purpose: 'ACCESS' },
      {
        algorithm: config.jwt.algorithm,
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
        expiresIn: config.jwt.accessTtlSeconds,
      },
    );
    const result = await jwt.verifyAsync<{
      sub: string;
      iat: number;
      exp: number;
    }>(token, {
      algorithms: ['HS256'],
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
    expect(result.sub).toBe('runtime-check');
    expect(result.exp - result.iat).toBe(3600);
    await expect(
      jwt.verifyAsync(token, {
        algorithms: ['HS256'],
        issuer: config.jwt.issuer,
        audience: config.jwt.audience,
        clockTimestamp: result.exp,
      }),
    ).rejects.toThrow('jwt expired');
    await expect(
      jwt.verifyAsync(token, {
        algorithms: ['HS256'],
        audience: 'wrong-audience',
      }),
    ).rejects.toThrow();
    const encoded = await hash('runtime-check-only-not-an-account-password', {
      type: argon2id,
    });
    expect(
      await verify(encoded, 'runtime-check-only-not-an-account-password'),
    ).toBe(true);
    expect(await verify(encoded, 'different')).toBe(false);
  });
});
