import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import request from 'supertest';
import sharp from 'sharp';
import { DataSource } from 'typeorm';
import { prepareTestDatabase } from './mysql-fixture';
import { freePort } from './file-handoff.helpers';
import {
  gracefulStop,
  launchApp,
  mysqlFile,
  runOperation,
} from './operations.helpers';
import {
  AttendanceEntity,
  EmployeeEntity,
  IdempotencyOperationEntity,
  ScheduleVersionEntity,
} from '../src/database/entities';

const input = {
  fullName: 'Operations HRD',
  email: 'operations@example.test',
  initialPassword: 'Fictional-Operations-Password',
  divisionCode: 'OPS',
  divisionName: 'Operations',
  positionCode: 'HRD',
  positionName: 'HRD',
};
const provisionArgs = ['provision-first-hrd', '--confirm-empty-installation'];

describe('task 020 production entry points and coordinated restore (native MySQL)', () => {
  let source: DataSource;
  let directory: string;
  let root: string;
  let baseline: string;
  let env: NodeJS.ProcessEnv;
  let base: string;
  let gateway: ReturnType<typeof launchApp> | undefined;
  let attendance: ReturnType<typeof launchApp> | undefined;
  let employeeId: string;
  let profileId: string;
  let authorization: string;
  let accessToken: string;
  let photo: Buffer;
  let key: string;
  let recorded: { id: string; photo: { id: string }; version: number };
  const captures: { schema: string; body: unknown }[] = [];
  const logs: string[] = [];

  async function start(mode: 'gateway' | 'attendance') {
    const app = launchApp(mode, env);
    if (mode === 'gateway') gateway = app;
    else attendance = app;
    await app.ready;
    return app;
  }

  async function stop() {
    await Promise.all([
      gracefulStop(gateway?.child),
      gracefulStop(attendance?.child),
    ]);
    logs.push(gateway?.logs() ?? '', attendance?.logs() ?? '');
    gateway = undefined;
    attendance = undefined;
  }

  async function login() {
    const response = await request(base)
      .post('/api/v1/auth/login')
      .send({
        email: input.email,
        password: input.initialPassword,
      })
      .expect(200);
    accessToken = response.body.accessToken;
    authorization = 'Bearer ' + accessToken;
    return response;
  }

  function checkIn() {
    return request(base)
      .post('/api/v1/me/attendances/check-in')
      .set('Authorization', authorization)
      .set('Idempotency-Key', key)
      .attach('photo', photo, {
        filename: 'operations.png',
        contentType: 'image/png',
      });
  }

  beforeAll(async () => {
    source = await prepareTestDatabase();
    // Refuse destructive rehearsal unless every application table is empty.
    for (const table of [
      'employees',
      'divisions',
      'positions',
      'file_objects',
      'attendances',
      'schedule_versions',
      'schedule_events',
      'holidays',
      'holiday_calendars',
      'idempotency_operations',
    ]) {
      const [row] = await source.query(
        `SELECT COUNT(*) AS total FROM ${table}`,
      );
      if (Number(row.total) !== 0)
        throw new Error(
          'Operations rehearsal requires an empty dedicated _test database',
        );
    }
    directory = await mkdtemp(join(tmpdir(), 'wfh-operations-'));
    root = join(directory, 'files');
    const [httpPort, rpcPort] = await Promise.all([freePort(), freePort()]);
    env = {
      ...process.env,
      NODE_ENV: 'test',
      STORAGE_ROOT: root,
      PORT: String(httpPort),
      ATTENDANCE_RPC_PORT: String(rpcPort),
      ATTENDANCE_RPC_DEADLINE_MS: '500',
    };
    base = `http://127.0.0.1:${httpPort}`;
    const baselinePath = join(directory, 'baseline.sql');
    await mysqlFile('dump', env.DB_NAME!, baselinePath, env);
    baseline = baselinePath;
    photo = await sharp({
      create: { width: 4, height: 4, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
  });

  afterAll(async () => {
    let restored = false;
    try {
      await stop();
      if (baseline) await mysqlFile('restore', env.DB_NAME!, baseline, env);
      restored = true;
    } finally {
      await source?.destroy();
      // Retain the private recovery set if teardown restore fails.
      if (restored && directory)
        await rm(directory, { recursive: true, force: true });
    }
    if (process.env.CONTRACT_CAPTURE_PATH)
      await writeFile(
        process.env.CONTRACT_CAPTURE_PATH + '-operations.json',
        JSON.stringify(captures),
        { mode: 0o600 },
      );
  });

  it('rolls back all provisioning references when the employee insert fails', async () => {
    await source.query(
      "CREATE TRIGGER operations_fail BEFORE INSERT ON employees FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test provisioning rollback'",
    );
    try {
      expect((await runOperation(provisionArgs, input, env)).code).toBe(1);
      for (const table of ['employees', 'divisions', 'positions']) {
        expect(
          Number(
            (await source.query(`SELECT COUNT(*) AS total FROM ${table}`))[0]
              .total,
          ),
        ).toBe(0);
      }
    } finally {
      await source.query('DROP TRIGGER operations_fail');
    }
  });

  it('requires explicit fictional development mode and refuses to reset any existing account', async () => {
    expect(
      (
        await runOperation(
          ['seed-development', '--confirm-fictional-data'],
          input,
          env,
        )
      ).code,
    ).toBe(1);
    const development = { ...env, NODE_ENV: 'development' };
    const seeded = await runOperation(
      ['seed-development', '--confirm-fictional-data'],
      input,
      development,
    );
    expect(seeded.code).toBe(0);
    const account = await source.manager.findOneByOrFail(EmployeeEntity, {
      id: JSON.parse(seeded.stdout).employeeId,
    });
    expect(account.email).toBe('fictional-hrd@example.test');
    expect((await runOperation(provisionArgs, input, development)).code).toBe(
      1,
    );
    expect(await source.manager.count(EmployeeEntity)).toBe(1);
    await mysqlFile('restore', env.DB_NAME!, baseline, env);
  });

  it('serializes concurrent first-HRD CLI attempts and never logs the initial credential', async () => {
    const results = await Promise.all([
      runOperation(provisionArgs, input, {
        ...env,
        NODE_ENV: 'production',
        CORS_ORIGINS: '',
        CSRF_TRUSTED_ORIGINS: '',
      }),
      runOperation(provisionArgs, input, {
        ...env,
        NODE_ENV: 'production',
        CORS_ORIGINS: '',
        CSRF_TRUSTED_ORIGINS: '',
      }),
    ]);
    expect(
      results.map((result) => result.code).sort((a, b) => a! - b!),
    ).toEqual([0, 1]);
    employeeId = JSON.parse(
      results.find((result) => result.code === 0)!.stdout,
    ).employeeId;
    expect(await source.manager.count(EmployeeEntity)).toBe(1);
    for (const result of results) {
      expect(result.stdout + result.stderr).not.toContain(
        input.initialPassword,
      );
      expect(result.stdout + result.stderr).not.toContain(env.DB_PASSWORD);
    }
  });

  it('starts the gateway with attendance absent and confines failures to attendance routes', async () => {
    await start('gateway');
    await login();
    await request(base)
      .get('/api/v1/me')
      .set('Authorization', authorization)
      .expect(200);
    const unavailable = await request(base)
      .get('/api/v1/me/home')
      .set('Authorization', authorization)
      .expect(503);
    captures.push({ schema: 'Problem', body: unavailable.body });
    await start('attendance');
    const home = await request(base)
      .get('/api/v1/me/home')
      .set('Authorization', authorization)
      .expect(200);
    captures.push({ schema: 'Home', body: home.body });
  });

  it('preserves production profile/evidence bytes, attendance and original-key replay through SQL+disk restore', async () => {
    const employee = await request(base)
      .patch(`/api/v1/hr/employees/${employeeId}`)
      .set('Authorization', authorization)
      .set('Idempotency-Key', randomUUID())
      .field('expectedVersion', '1')
      .attach('photo', photo, {
        filename: 'profile.png',
        contentType: 'image/png',
      })
      .expect(200);
    profileId = employee.body.photo.id;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    // Fixture schedule spans the current instant; the production command uses its actual clock.
    const startTime = new Date(now.getTime() - 60000)
      .toISOString()
      .slice(11, 16);
    const endTime = new Date(now.getTime() + 3600000)
      .toISOString()
      .slice(11, 16);
    const startDate = new Date(now.getTime() - 60000)
      .toISOString()
      .slice(0, 10);
    await source.manager.insert(ScheduleVersionEntity, {
      id: randomUUID(),
      workingDays: [1, 2, 3, 4, 5, 6, 7],
      startTime,
      endTime,
      endDayOffset: endTime <= startTime ? 1 : 0,
      timeZone: 'UTC',
      effectiveFrom: startDate,
      effectiveAt: new Date(startDate + 'T00:00:00Z'),
      createdBy: employeeId,
    });
    key = randomUUID();
    const response = await checkIn().expect(201);
    recorded = response.body;
    captures.push({ schema: 'Attendance', body: response.body });
    await stop();
    const [connections] = await source.query(
      'SELECT COUNT(*) AS total FROM information_schema.PROCESSLIST WHERE DB = ? AND ID <> CONNECTION_ID()',
      [env.DB_NAME],
    );
    expect(Number(connections.total)).toBe(0);
    const sql = join(directory, 'snapshot.sql');
    const files = join(directory, 'backup-files');
    await mysqlFile('dump', env.DB_NAME!, sql, env);
    await cp(root, files, { recursive: true, preserveTimestamps: true });
    // Baseline restore removes all fixture rows; remove live disk to prove both halves restore.
    await mysqlFile('restore', env.DB_NAME!, baseline, env);
    await rm(root, { recursive: true });
    expect(await source.manager.count(AttendanceEntity)).toBe(0);
    await mysqlFile('restore', env.DB_NAME!, sql, env);
    await cp(files, root, { recursive: true, preserveTimestamps: true });
    await Promise.all([start('attendance'), start('gateway')]);
    await login();
    for (const fileId of [profileId, recorded.photo.id]) {
      const content = await request(base)
        .get(`/api/v1/files/${fileId}`)
        .set('Authorization', authorization)
        .expect(200);
      expect(content.body).toEqual(photo);
    }
    const detail = await request(base)
      .get(`/api/v1/me/attendances/${recorded.id}`)
      .set('Authorization', authorization)
      .expect(200);
    expect(detail.body).toEqual(recorded);
    expect((await checkIn().expect(201)).headers['idempotency-replayed']).toBe(
      'true',
    );
    expect(await source.manager.count(AttendanceEntity)).toBe(1);
    const history = await request(base)
      .get(`/api/v1/me/attendance-days?from=${today}&to=${today}`)
      .set('Authorization', authorization)
      .expect(200);
    captures.push({ schema: 'AttendanceDayPage', body: history.body });
  });

  it('retains profile access during attendance shutdown, then reconnects after restart', async () => {
    await gracefulStop(attendance?.child);
    await request(base)
      .get('/api/v1/me/home')
      .set('Authorization', authorization)
      .expect(503);
    await request(base)
      .get('/api/v1/me')
      .set('Authorization', authorization)
      .expect(200);
    await request(base)
      .get(`/api/v1/files/${recorded.photo.id}`)
      .set('Authorization', authorization)
      .expect(503);
    const profile = await request(base)
      .get(`/api/v1/files/${profileId}`)
      .set('Authorization', authorization)
      .expect(200);
    expect(profile.body).toEqual(photo);
    logs.push(attendance!.logs());
    await start('attendance');
    await request(base)
      .get(`/api/v1/files/${recorded.photo.id}`)
      .set('Authorization', authorization)
      .expect(200);
    await gracefulStop(gateway?.child);
    logs.push(gateway!.logs());
    await start('gateway');
    await login();
  });

  it('fails storage writes safely and recovers after the same private directory returns', async () => {
    await rename(root, root + '-offline');
    try {
      await writeFile(root, 'simulated missing mount', { mode: 0o600 });
      await request(base)
        .get(`/api/v1/files/${recorded.photo.id}`)
        .set('Authorization', authorization)
        .expect(503);
      await request(base)
        .patch(`/api/v1/hr/employees/${employeeId}`)
        .set('Authorization', authorization)
        .set('Idempotency-Key', randomUUID())
        .field('expectedVersion', '2')
        .attach('photo', photo, {
          filename: 'failed.png',
          contentType: 'image/png',
        })
        .expect(503);
      expect(
        (
          await source.manager.findOneByOrFail(EmployeeEntity, {
            id: employeeId,
          })
        ).version,
      ).toBe(2);
    } finally {
      await rm(root, { force: true });
      await rename(root + '-offline', root);
    }
    await request(base)
      .get(`/api/v1/files/${recorded.photo.id}`)
      .set('Authorization', authorization)
      .expect(200);
  });

  it('cleans only bounded expired receipts through the CLI', async () => {
    await source.manager.update(
      IdempotencyOperationEntity,
      { actorId: employeeId },
      { expiresAt: new Date('2020-01-01T00:00:00Z') },
    );
    const count = await source.manager.count(IdempotencyOperationEntity);
    const result = await runOperation(['cleanup-receipts', '1'], {}, env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ deleted: 1 });
    expect(await source.manager.count(IdempotencyOperationEntity)).toBe(
      count - 1,
    );
    expect(await source.manager.count(AttendanceEntity)).toBe(1);
  });

  it('rejects occupied TCP, missing DB, invalid settings and invalid disk without leaking secrets', async () => {
    await stop();
    const server = createServer();
    server.listen(Number(env.ATTENDANCE_RPC_PORT), '127.0.0.1');
    await once(server, 'listening');
    try {
      const occupied = launchApp('attendance', env);
      await expect(occupied.ready).rejects.toThrow();
      expect((await occupied.exited)[0]).toBe(1);
      logs.push(occupied.logs());
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const offlinePort = await freePort();
    const unavailableRoot = join(directory, 'not-directory');
    await writeFile(unavailableRoot, 'unavailable');
    for (const mode of ['gateway', 'attendance'] as const) {
      for (const overrides of [
        { DB_PORT: String(offlinePort), DB_CONNECT_TIMEOUT_MS: '200' },
        { JWT_SECRET: 'invalid' },
        { STORAGE_ROOT: unavailableRoot },
      ]) {
        const app = launchApp(mode, { ...env, ...overrides });
        await expect(app.ready).rejects.toThrow();
        expect((await app.exited)[0]).toBe(1);
        logs.push(app.logs());
      }
    }
    await Promise.all([start('attendance'), start('gateway')]);
    await login();
    expect(
      await readFile(
        join(
          root,
          (await source.query('SELECT object_key FROM file_objects LIMIT 1'))[0]
            .object_key,
        ),
      ),
    ).toEqual(photo);
    for (const log of logs) {
      for (const secret of [
        accessToken,
        input.initialPassword,
        env.DB_PASSWORD!,
        env.JWT_SECRET!,
        env.ATTENDANCE_RPC_CREDENTIAL!,
        root,
      ]) {
        expect(log).not.toContain(secret);
      }
    }
  });
});
