import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource, In } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { AccessTokenService } from '../src/auth/access-token.service';
import { AuthService } from '../src/auth/auth.service';
import { AuthRepository } from '../src/auth/auth.repository';
import { EmployeeRepository } from '../src/employees/employee.repository';
import { IdempotencyRepository } from '../src/idempotency/idempotency.repository';
import { RUNTIME_CONFIG } from '../src/runtime/runtime.config';
import type { RuntimeConfig } from '../src/runtime/runtime.config';
import { StorageService } from '../src/files/storage.service';
import { configureHttp } from '../src/http/configure-http';
import { loadRuntimeConfig } from '../src/runtime/runtime.config';
import {
  DivisionEntity,
  PositionEntity,
  EmployeeEntity,
  ScheduleVersionEntity,
  FileObjectEntity,
  IdempotencyOperationEntity,
} from '../src/database/entities';
import { insertFixture, prepareTestDatabase } from './mysql-fixture';

describe('employee HTTP with native MySQL', () => {
  let app: NestExpressApplication;
  let source: DataSource;
  let ids: Awaited<ReturnType<typeof insertFixture>>;
  let employeeIds: string[];
  let hr: string;
  let ordinary: string;
  const responses: { schema: string; body: unknown }[] = [];
  const base = '/api/v1/hr/employees';
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
    await writeFile(
      join(loadRuntimeConfig().storage.root, 'employee-responses.json'),
      JSON.stringify(responses),
    );
    await app?.close();
  });
  beforeEach(async () => {
    ids = await source.transaction(insertFixture);
    employeeIds = [ids.employee, ids.otherEmployee];
    const tokens = app.get(AccessTokenService);
    hr =
      'Bearer ' +
      (await tokens.issue({ id: ids.otherEmployee, role: 'HRD' })).accessToken;
    ordinary =
      'Bearer ' +
      (await tokens.issue({ id: ids.employee, role: 'EMPLOYEE' })).accessToken;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await source.manager.delete(IdempotencyOperationEntity, {
      actorId: In(employeeIds),
    });
    await source.manager.delete(ScheduleVersionEntity, { id: ids.schedule });
    const photos = await source.manager.find(FileObjectEntity, {
      where: { ownerEmployeeId: In(employeeIds) },
      select: { id: true, objectKey: true },
    });
    await source.manager.update(
      EmployeeEntity,
      { id: In(employeeIds) },
      { photoFileId: null },
    );
    await source.manager.delete(FileObjectEntity, {
      ownerEmployeeId: In(employeeIds),
    });

    for (const photo of photos)
      await app.get(StorageService).delete(photo.objectKey);

    await source.manager.delete(EmployeeEntity, { id: In(employeeIds) });
    await source.manager.delete(PositionEntity, { id: ids.position });
    await source.manager.delete(DivisionEntity, { id: ids.division });
    jest.restoreAllMocks();
  });

  function body(extra: object = {}) {
    return {
      fullName: 'Employee',
      email: randomUUID() + '@example.test',
      divisionId: ids.division,
      positionId: ids.position,
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      ...extra,
    };
  }

  function post(input: object, key = randomUUID(), token = hr) {
    let command = request(app.getHttpServer())
      .post(base)
      .set('Authorization', token)
      .set('Idempotency-Key', key);

    for (const [field, value] of Object.entries(input)) {
      command = command.field(field, String(value));
    }

    return command;
  }

  async function create(extra: object = {}) {
    const input = body(extra),
      key = randomUUID();
    const response = await post(input, key).expect(201);
    const id = response.body.employee.id as string;
    employeeIds.push(id);
    return { input, key, response, id };
  }

  function get(path: string, token = hr) {
    return request(app.getHttpServer()).get(path).set('Authorization', token);
  }

  function patch(id: string, version: string, key = randomUUID()) {
    return request(app.getHttpServer())
      .patch(`${base}/${id}`)
      .set('Authorization', hr)
      .set('Idempotency-Key', key)
      .field('expectedVersion', version);
  }

  async function image() {
    return sharp({
      create: { width: 8, height: 8, channels: 3, background: '#ff0000' },
    })
      .png()
      .toBuffer();
  }

  it('projects all response schemas and stores only employeeId for creation', async () => {
    const { id, input, key, response } = await create();
    responses.push({ schema: 'EmployeeCreated', body: response.body });
    expect(
      response.body.initialCredentials.initialPassword.length,
    ).toBeGreaterThanOrEqual(15);
    expect(
      (
        await source.manager.findOneOrFail(IdempotencyOperationEntity, {
          where: { idempotencyKey: key },
          select: { result: true },
        })
      ).result,
    ).toEqual({ employeeId: id });
    const detail = await get(`${base}/${id}`).expect(200);
    responses.push({ schema: 'Employee', body: detail.body });
    expect(detail.body).not.toHaveProperty('initialPassword');
    const changed = await patch(id, '1')
      .field('email', randomUUID() + '@example.test')
      .expect(200);
    responses.push({ schema: 'Employee', body: changed.body });
    const replay = await post(input, key).expect(201);
    expect(replay.body.initialCredentials.email).toBe(changed.body.email);
    expect(replay.body.initialCredentials.initialPassword).toBe(
      response.body.initialCredentials.initialPassword,
    );
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const credentials = await get(`${base}/${id}/initial-credentials`).expect(
      200,
    );
    responses.push({
      schema: 'InitialCredentialsRead',
      body: credentials.body,
    });
    expect(credentials.headers['cache-control']).toBe('private, no-store');
    await post({ ...input, fullName: 'Other' }, key).expect(422);
  });
  it('creates the employee and photo together, replays without extra files and fingerprints photo bytes', async () => {
    const input = body({ role: 'HRD', confirmHrAccess: true });
    const key = randomUUID();
    const png = await image();
    const created = await post(input, key)
      .attach('photo', png, 'initial.png')
      .expect(201);
    const id = created.body.employee.id as string;
    employeeIds.push(id);
    responses.push({ schema: 'EmployeeCreated', body: created.body });
    expect(created.body.employee.photo).not.toBeNull();
    expect(created.body.employee.version).toBe(1);
    await get(created.body.employee.photo.contentPath).expect(200);
    const repeated = await post(input, key)
      .attach('photo', png, 'initial.png')
      .expect(201);
    expect(repeated.body).toEqual(created.body);
    expect(
      await source.manager.countBy(FileObjectEntity, { ownerEmployeeId: id }),
    ).toBe(1);
    const conflict = await post(input, key).expect(422);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', hr)
      .send(input)
      .expect(415);
    await post(body({ confirmHrAccess: 'TRUE' })).expect(400);
  });

  it('saves no employee, photo or receipt when create validation, disk writes or receipt storage fail', async () => {
    const png = await image();
    const input = body();
    const key = randomUUID();
    const before = await readdir(loadRuntimeConfig().storage.root);
    await post(input, key)
      .attach('photo', Buffer.from('bad image'), 'bad.png')
      .expect(422);
    const storage = jest
      .spyOn(app.get(StorageService), 'put')
      .mockRejectedValue(new Error('Injected disk failure'));
    await post(input, key).attach('photo', png, 'photo.png').expect(500);
    storage.mockRestore();
    const save = jest
      .spyOn(app.get(IdempotencyRepository), 'saveCompleted')
      .mockRejectedValue(new Error('Injected receipt failure'));
    await post(input, key).attach('photo', png, 'photo.png').expect(500);
    save.mockRestore();
    expect(
      await source.manager.countBy(EmployeeEntity, { email: input.email }),
    ).toBe(0);
    expect(
      await source.manager.countBy(IdempotencyOperationEntity, {
        idempotencyKey: key,
      }),
    ).toBe(0);
    expect(await readdir(loadRuntimeConfig().storage.root)).toEqual(before);
    const retry = await post(input, key)
      .attach('photo', png, 'photo.png')
      .expect(201);
    employeeIds.push(retry.body.employee.id);
    expect(retry.body.employee.photo).not.toBeNull();
  });

  it('races normalized duplicate emails and rolls creation back on receipt failure', async () => {
    const input = body();
    const results = await Promise.all([
      post(input),
      post({ ...input, email: ' ' + input.email.toUpperCase() + ' ' }),
    ]);

    for (const r of results)
      if (r.status === 201) employeeIds.push(r.body.employee.id);

    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe(
      'EMAIL_ALREADY_USED',
    );
    const failed = body();
    jest
      .spyOn(app.get(IdempotencyRepository), 'saveCompleted')
      .mockRejectedValue(new Error('Injected receipt failure'));
    await post(failed).expect(500);
    expect(
      await source.manager.countBy(EmployeeEntity, { email: failed.email }),
    ).toBe(0);
  });
  it('enforces guards before replay, strict DTOs, keys, HR confirmation and filters', async () => {
    const { id, input, key } = await create({ fullName: 'Literal % employee' });
    await post(input, key, ordinary).expect(403);
    await post({ ...input, password: 'client' }, key).expect(400);
    await post(body({ role: 'HRD' })).expect(422);
    await post(input, 'bad' as any).expect(400);
    await request(app.getHttpServer())
      .post(base)
      .set('Authorization', hr)
      .field('fullName', 'Missing key')
      .expect(400);

    for (const path of [
      base,
      `${base}/${id}`,
      `${base}/${id}/initial-credentials`,
    ]) {
      await get(path, ordinary).expect(403);
      await request(app.getHttpServer()).get(path).expect(401);
    }

    await request(app.getHttpServer())
      .patch(`${base}/${id}`)
      .set('Authorization', ordinary)
      .expect(403);
    await request(app.getHttpServer())
      .put(`${base}/${id}/role`)
      .set('Authorization', ordinary)
      .send({})
      .expect(403);
    await get(base + '?page=01').expect(400);
    await get(base + '?role=OTHER').expect(400);
    const list = await get(base)
      .query({
        q: '%',
        divisionId: ids.division,
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        pageSize: 1,
      })
      .expect(200);
    expect(list.body.pagination.totalItems).toBe(1);
    responses.push({ schema: 'EmployeePage', body: list.body });
    expect(JSON.stringify(list.body)).not.toMatch(
      /initialPassword|passwordHash|initialCredentials/,
    );
  });
  it('preserves credential state on role changes and permits last-HRD changes using issued claims', async () => {
    const { id, response } = await create();
    const role = await request(app.getHttpServer())
      .put(`${base}/${id}/role`)
      .set('Authorization', hr)
      .send({ role: 'HRD', confirmHrAccess: true, expectedVersion: 1 })
      .expect(200);
    responses.push({ schema: 'Employee', body: role.body });
    expect(
      (await get(`${base}/${id}/initial-credentials`).expect(200)).body
        .initialCredentials,
    ).toEqual(response.body.initialCredentials);
    await request(app.getHttpServer())
      .put(`${base}/${id}/role`)
      .set('Authorization', hr)
      .send({ role: 'EMPLOYEE', confirmHrAccess: false, expectedVersion: 1 })
      .expect(409);
    await request(app.getHttpServer())
      .put(`${base}/${ids.otherEmployee}/role`)
      .set('Authorization', hr)
      .send({ role: 'EMPLOYEE', confirmHrAccess: false, expectedVersion: 1 })
      .expect(200);
    await patch(ids.otherEmployee, '2').field('status', 'INACTIVE').expect(200);
    await get(base).expect(200);
  });
  it('atomically handles photo omission/replacement/removal, replay and stale/error cleanup', async () => {
    const { id } = await create(),
      png = await image(),
      key = randomUUID();
    const uploaded = await patch(id, '1', key)
      .attach('photo', png, 'photo.png')
      .expect(200);
    responses.push({ schema: 'Employee', body: uploaded.body });
    const photoId = uploaded.body.photo.id;
    await get(`/api/v1/files/${photoId}`).expect(200);
    expect(
      (await patch(id, '1', key).attach('photo', png, 'photo.png').expect(200))
        .body,
    ).toEqual(uploaded.body);
    expect(
      await source.manager.countBy(FileObjectEntity, { ownerEmployeeId: id }),
    ).toBe(1);
    await patch(id, '2').field('fullName', 'Edited').expect(200);
    await patch(id, '1').attach('photo', png, 'stale.png').expect(409);
    await patch(id, '3')
      .field('removePhoto', 'true')
      .attach('photo', png, 'conflict.png')
      .expect(422);
    await patch(id, '3')
      .attach('photo', Buffer.from('invalid'), 'invalid.png')
      .expect(422);
    const before = await readdir(loadRuntimeConfig().storage.root);
    const fail = jest
      .spyOn(app.get(IdempotencyRepository), 'saveCompleted')
      .mockRejectedValue(new Error('Injected receipt failure'));
    await patch(id, '3').attach('photo', png, 'failed.png').expect(500);
    fail.mockRestore();
    expect(await readdir(loadRuntimeConfig().storage.root)).toEqual(before);
    expect((await get(`${base}/${id}`).expect(200)).body.photo.id).toBe(
      photoId,
    );
    const replaced = await patch(id, '3')
      .attach('photo', png, 'replace.png')
      .expect(200);
    await get(`/api/v1/files/${photoId}`).expect(404);
    expect(
      (await patch(id, '4').field('removePhoto', 'true').expect(200)).body
        .photo,
    ).toBeNull();
    await get(`/api/v1/files/${replaced.body.photo.id}`).expect(404);
  });
  it('rejects malformed/empty edits, invalid references and file-write failure without changes', async () => {
    const { id } = await create();

    for (const v of ['01', '-1', '1.0', '9007199254740992'])
      await patch(id, v).field('fullName', 'X').expect(400);

    await patch(id, '1').expect(400);
    await patch(id, '1').field('removePhoto', 'false').expect(400);
    await patch(id, '1').field('removePhoto', 'TRUE').expect(400);
    await patch(id, '1').field('role', 'HRD').expect(400);
    await patch(id, '1').field('divisionId', randomUUID()).expect(422);
    await patch(id, '1').field('positionId', randomUUID()).expect(422);
    await source.manager.update(
      DivisionEntity,
      { id: ids.division },
      { status: 'INACTIVE' },
    );
    await patch(id, '1').field('divisionId', ids.division).expect(422);
    await patch(id, '1').field('fullName', 'Historical reference').expect(200);
    jest
      .spyOn(app.get(StorageService), 'put')
      .mockRejectedValue(new Error('Injected write failure'));
    await patch(id, '2')
      .attach('photo', await image(), 'failure.png')
      .expect(500);
    expect((await get(`${base}/${id}`).expect(200)).body.photo).toBeNull();
    await request(app.getHttpServer())
      .patch(`${base}/${id}`)
      .set('Authorization', hr)
      .send({ expectedVersion: 2, fullName: 'X' })
      .expect(415);
  });
  it('rejects a saturated upload before saving employee data and permits retry with the same key', async () => {
    const { id } = await create();
    const config = app.get<RuntimeConfig>(RUNTIME_CONFIG);
    const storage = app.get(StorageService);
    const originalPut = storage.put.bind(storage);
    const png = await image();
    const key = randomUUID();
    let entered = 0;
    let ready!: () => void;
    let release!: () => void;
    const allOccupied = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold = jest
      .spyOn(storage, 'put')
      .mockImplementation(async (objectKey, bytes) => {
        entered++;

        if (entered === config.storage.maxConcurrentUploads) ready();

        await released;
        await originalPut(objectKey, bytes);
      });
    const occupying = Array.from(
      { length: config.storage.maxConcurrentUploads },
      () =>
        patch(ids.employee, '1')
          .attach('photo', png, 'occupied.png')
          .then((response) => response),
    );

    try {
      await allOccupied;
      const rejected = await patch(id, '1', key)
        .field('fullName', 'Must not save')
        .attach('photo', png, 'photo.png')
        .expect(429);
      expect(rejected.body.code).toBe('UPLOAD_LIMIT');
      const newEmployee = body();
      await post(newEmployee).attach('photo', png, 'create.png').expect(429);
      expect(
        await source.manager.countBy(EmployeeEntity, {
          email: newEmployee.email,
        }),
      ).toBe(0);
      expect(rejected.headers['retry-after']).toBe('1');
      await request(app.getHttpServer())
        .post(base)
        .set('Authorization', hr)
        .set('Content-Type', 'multipart/form-data; boundary=broken')
        .send('invalid multipart')
        .expect(429);
      const unchanged = await source.manager.findOneByOrFail(EmployeeEntity, {
        id,
      });
      expect(unchanged.fullName).toBe('Employee');
      expect(unchanged.version).toBe(1);
      expect(unchanged.photoFileId).toBeNull();
      expect(
        await source.manager.countBy(IdempotencyOperationEntity, {
          idempotencyKey: key,
        }),
      ).toBe(0);
    } finally {
      release();
      await Promise.all(occupying);
      hold.mockRestore();
    }

    const retried = await patch(id, '1', key)
      .field('fullName', 'Must not save')
      .attach('photo', png, 'photo.png')
      .expect(200);
    expect(retried.body.fullName).toBe('Must not save');
    expect(retried.body.version).toBe(2);
    expect(retried.body.photo).not.toBeNull();
  });

  it('serializes competing employee versions and rejects changed multipart bytes under a completed key', async () => {
    const { id } = await create();
    const edits = await Promise.all(
      ['First', 'Second'].map((name) => patch(id, '1').field('fullName', name)),
    );
    expect(edits.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    const key = randomUUID(),
      png = await image();
    await patch(id, '2', key).attach('photo', png, 'photo.png').expect(200);
    const other = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#0000ff' },
    })
      .png()
      .toBuffer();
    const mismatch = await patch(id, '2', key)
      .attach('photo', other, 'photo.png')
      .expect(422);
    expect(mismatch.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await get(`${base}/${id}`).expect(200)).body.version).toBe(3);
  });
  it('returns current credentials after a real self password change and rejects inactive assignments', async () => {
    const { id, input, key, response } = await create();
    const changed = await app.get(AuthService).changePassword(
      { id, role: 'EMPLOYEE' },
      {
        currentPassword: response.body.initialCredentials.initialPassword,
        newPassword: 'Replacement-password-for-task009',
        confirmPassword: 'Replacement-password-for-task009',
      },
    );
    expect(changed).toBeUndefined();
    await get(`${base}/${id}/initial-credentials`).expect(409);
    const replay = await post(input, key).expect(409);
    expect(replay.body.details).toEqual({
      employeeId: id,
      alreadyCreated: true,
    });
    expect(JSON.stringify(replay.body)).not.toContain(
      response.body.initialCredentials.initialPassword,
    );
    await source.manager.update(
      PositionEntity,
      { id: ids.position },
      { status: 'INACTIVE' },
    );
    await post(body()).expect(422);
  });
  it('validates an assignment with one locking join that protects the position and division', async () => {
    const writer = source.createQueryRunner();
    const contender = source.createQueryRunner();
    await writer.connect();
    await contender.connect();
    await writer.startTransaction('READ COMMITTED');
    const queries: string[] = [];
    const logger = jest
      .spyOn(source.logger, 'logQuery')
      .mockImplementation((sql) => {
        queries.push(sql);
      });

    try {
      const position = await app
        .get(EmployeeRepository)
        .position(writer.manager, ids.position, true);
      expect(position?.divisionId).toBe(ids.division);
      expect(position?.division.status).toBe('ACTIVE');
      expect(queries).toHaveLength(1);
      expect(queries[0]).toMatch(/JOIN .*divisions/i);
      expect(queries[0]).toMatch(/FOR UPDATE/i);
      logger.mockRestore();
      await contender.startTransaction('READ COMMITTED');

      for (const [table, target] of [
        ['positions', ids.position],
        ['divisions', ids.division],
      ]) {
        await expect(
          contender.query(
            `SELECT id FROM ${table} WHERE id = ? FOR UPDATE NOWAIT`,
            [target],
          ),
        ).rejects.toMatchObject({ driverError: { code: 'ER_LOCK_NOWAIT' } });
      }
    } finally {
      logger.mockRestore();

      if (contender.isTransactionActive) await contender.rollbackTransaction();

      if (writer.isTransactionActive) await writer.rollbackTransaction();

      await contender.release();
      await writer.release();
    }
  });

  it('uses relation joins through find options without per-employee queries or read transactions', async () => {
    const prefix = randomUUID();
    const employees = [];

    for (let index = 0; index < 3; index++) {
      employees.push(await create({ fullName: prefix + index }));
    }

    await patch(employees[0].id, '1')
      .attach('photo', await image(), 'batch-photo.png')
      .expect(200);

    const queries: string[] = [];
    const logger = jest
      .spyOn(source.logger, 'logQuery')
      .mockImplementation((statement) => {
        queries.push(statement);
      });

    try {
      const detail = await get(`${base}/${employees[0].id}`).expect(200);
      expect(detail.body.division.id).toBe(ids.division);
      expect(detail.body.position.id).toBe(ids.position);
      expect(detail.body.photo).not.toBeNull();
      expect(queries).toHaveLength(1);
      expect(queries[0]).toMatch(/^SELECT /i);
      queries.length = 0;

      for (const pageSize of [1, 3]) {
        const list = await get(base).query({ q: prefix, pageSize }).expect(200);
        expect(list.body.items).toHaveLength(pageSize);
        expect(list.body.pagination.totalItems).toBe(3);
        expect(queries).toHaveLength(3);

        for (const sql of queries) {
          expect(sql).toMatch(/^SELECT /i);
          expect(sql).not.toMatch(
            /FOR UPDATE|START TRANSACTION|COMMIT|initial_password|password_hash|object_key/i,
          );
        }

        queries.length = 0;
      }
    } finally {
      logger.mockRestore();
    }
  });

  it('reads committed employee details while another transaction holds an uncommitted update', async () => {
    const { id } = await create();
    const writer = source.createQueryRunner();
    await writer.connect();
    await writer.startTransaction('READ COMMITTED');

    try {
      await writer.manager.update(
        EmployeeEntity,
        { id },
        { fullName: 'Uncommitted name', version: 2 },
      );
      const detail = await get(`${base}/${id}`)
        .timeout({ response: 2000, deadline: 3000 })
        .expect(200);
      expect(detail.body.fullName).toBe('Employee');
      expect(detail.body.version).toBe(1);
    } finally {
      await writer.rollbackTransaction();
      await writer.release();
    }
  });

  it('serializes credential reads/create replay behind password change and never regenerates credentials', async () => {
    const { id, input, key } = await create();
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction('READ COMMITTED');

    try {
      const auth = app.get(AuthRepository),
        employee = await auth.findCredentials(runner.manager, { id });
      let done = false;
      const read = get(`${base}/${id}/initial-credentials`).then((r) => {
        done = true;
        return r;
      });
      const replay = post(input, key).then((r) => r);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(done).toBe(false);
      await auth.changePassword(
        runner.manager,
        employee!,
        'test-only-non-login-hash',
      );
      await runner.commitTransaction();
      expect((await read).status).toBe(409);
      const denied = await replay;
      expect(denied.status).toBe(409);
      expect(denied.body.details).toEqual({
        employeeId: id,
        alreadyCreated: true,
      });
      expect(await source.manager.countBy(EmployeeEntity, { id })).toBe(1);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();

      await runner.release();
    }
  });
});
