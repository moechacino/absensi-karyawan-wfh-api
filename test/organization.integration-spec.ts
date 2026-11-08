import { IdempotencyRepository } from '../src/idempotency/idempotency.repository';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource, In } from 'typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { AccessTokenService } from '../src/auth/access-token.service';
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

describe('organization HTTP with native MySQL', () => {
  let app: NestExpressApplication;
  let source: DataSource;
  let ids: Awaited<ReturnType<typeof insertFixture>>;
  let divisionIds: string[];
  let positionIds: string[];
  let hr: string;
  let employee: string;
  let prefix: string;
  let counter: number;
  const responses: { schema: string; body: unknown }[] = [];

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
      join(loadRuntimeConfig().storage.root, 'organization-responses.json'),
      JSON.stringify(responses),
    );
    await app?.close();
  });

  beforeEach(async () => {
    ids = await source.transaction(insertFixture);
    divisionIds = [ids.division];
    positionIds = [ids.position];
    prefix = 'ORG' + randomUUID().slice(0, 8);
    counter = 0;
    const tokens = app.get(AccessTokenService);
    hr =
      'Bearer ' +
      (await tokens.issue({ id: ids.otherEmployee, role: 'HRD' })).accessToken;
    employee =
      'Bearer ' +
      (await tokens.issue({ id: ids.employee, role: 'EMPLOYEE' })).accessToken;
  });

  afterEach(async () => {
    await source.manager.delete(IdempotencyOperationEntity, {
      actorId: In([ids.employee, ids.otherEmployee]),
    });
    await source.manager.delete(ScheduleVersionEntity, { id: ids.schedule });
    await source.manager.delete(FileObjectEntity, { id: ids.file });
    await source.manager.delete(EmployeeEntity, {
      id: In([ids.employee, ids.otherEmployee]),
    });
    await source.manager.delete(PositionEntity, { id: In(positionIds) });
    await source.manager.delete(DivisionEntity, { id: In(divisionIds) });
  });

  function post(
    kind: 'divisions' | 'positions',
    body: object,
    key = randomUUID(),
  ) {
    return request(app.getHttpServer())
      .post('/api/v1/hr/' + kind)
      .set('Authorization', hr)
      .set('Idempotency-Key', key)
      .send(body);
  }

  async function division(extra: object = {}) {
    const body = {
      code: prefix + ++counter,
      name: 'Division',
      status: 'ACTIVE',
      ...extra,
    };
    const response = await post('divisions', body).expect(201);
    divisionIds.push(response.body.id);

    return response;
  }

  async function position(divisionId: string, extra: object = {}) {
    const response = await post('positions', {
      code: prefix + ++counter,
      name: 'Position',
      status: 'ACTIVE',
      divisionId,
      ...extra,
    }).expect(201);
    positionIds.push(response.body.id);

    return response;
  }

  function patch(kind: string, id: string, body: object) {
    return request(app.getHttpServer())
      .patch(`/api/v1/hr/${kind}/${id}`)
      .set('Authorization', hr)
      .send(body);
  }

  it('implements all six response shapes and replays the original create after an edit', async () => {
    const key = randomUUID();
    const body = { code: prefix, name: 'Division', status: 'ACTIVE' };
    const created = await post(
      'divisions',
      { ...body, code: ' ' + body.code + ' ', name: ' ' + body.name + ' ' },
      key,
    ).expect(201);
    divisionIds.push(created.body.id);
    responses.push({ schema: 'Division', body: created.body });
    expect(created.headers['idempotency-replayed']).toBe('false');
    const updated = await patch('divisions', created.body.id, {
      expectedVersion: 1,
      name: 'Updated',
      description: null,
    }).expect(200);
    responses.push({ schema: 'Division', body: updated.body });
    expect(updated.body.version).toBe(2);
    const replay = await post(
      'divisions',
      { ...body, description: null },
      key,
    ).expect(201);
    expect(replay.body).toEqual(created.body);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    const conflict = await post(
      'divisions',
      { ...body, name: 'Changed input' },
      key,
    ).expect(422);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    await post('divisions', { ...body, unexpected: true }, key).expect(400);
    const p = await position(created.body.id);
    responses.push({ schema: 'Position', body: p.body });
    const changed = await patch('positions', p.body.id, {
      expectedVersion: 1,
      name: 'New position',
      status: 'INACTIVE',
    }).expect(200);
    responses.push({ schema: 'Position', body: changed.body });

    for (const [kind, schema] of [
      ['divisions', 'DivisionPage'],
      ['positions', 'PositionPage'],
    ] as const) {
      const list = await request(app.getHttpServer())
        .get('/api/v1/hr/' + kind)
        .set('Authorization', hr)
        .query({ q: prefix })
        .expect(200);
      responses.push({ schema, body: list.body });
      expect(list.body.pagination.totalItems).toBe(1);
      expect(list.body.items[0]).not.toHaveProperty('createdAt');
    }
  });

  it('rolls back the business write if storing its command receipt fails', async () => {
    const body = {
      code: prefix,
      name: 'Atomic command runner',
      status: 'ACTIVE',
    };
    const key = randomUUID();
    const receipts = app.get(IdempotencyRepository);
    const save = jest
      .spyOn(receipts, 'saveCompleted')
      .mockRejectedValue(new Error('Injected receipt failure'));

    try {
      await post('divisions', body, key).expect(500);
      expect(
        await source.manager.countBy(DivisionEntity, { code: prefix }),
      ).toBe(0);
      expect(
        await source.manager.countBy(IdempotencyOperationEntity, {
          actorId: ids.otherEmployee,
          idempotencyKey: key,
        }),
      ).toBe(0);
    } finally {
      save.mockRestore();
    }

    const success = await post('divisions', body, key).expect(201);
    divisionIds.push(success.body.id);
    const deniedToken =
      'Bearer ' +
      (
        await app
          .get(AccessTokenService)
          .issue({ id: ids.otherEmployee, role: 'EMPLOYEE' })
      ).accessToken;
    await request(app.getHttpServer())
      .post('/api/v1/hr/divisions')
      .set('Authorization', deniedToken)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(403);
    expect((await post('divisions', body, key).expect(201)).body).toEqual(
      success.body,
    );
  });

  it('maps concurrent duplicate codes to a safe conflict and persists 40-character codes', async () => {
    const code = (prefix + 'X'.repeat(40)).slice(0, 40);
    const body = { code, name: 'Concurrent', status: 'ACTIVE' };
    const results = await Promise.all([
      post('divisions', body),
      post('divisions', body),
    ]);

    for (const response of results) {
      if (response.status === 201) {
        divisionIds.push(response.body.id);
      }
    }

    expect(
      results.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([201, 409]);
    expect(results.find((response) => response.status === 409)?.body.code).toBe(
      'CODE_ALREADY_EXISTS',
    );
    expect(await source.manager.countBy(DivisionEntity, { code })).toBe(1);
  });

  it('serializes competing PATCH versions without overwriting the winning update', async () => {
    const d = await division();
    const results = await Promise.all(
      ['First', 'Second'].map((name) =>
        patch('divisions', d.body.id, { expectedVersion: 1, name }),
      ),
    );
    expect(
      results.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([200, 409]);
    const conflict = results.find((response) => response.status === 409)!;
    expect(conflict.body.code).toBe('VERSION_CONFLICT');
    expect(conflict.body.details.currentVersion).toBe(2);
    const actual = await source.manager.findOneByOrFail(DivisionEntity, {
      id: d.body.id,
    });
    expect(actual.version).toBe(2);
    expect(actual.name).toBe(
      results.find((response) => response.status === 200)!.body.name,
    );
  });

  it('blocks moving referenced positions and validates the active destination for unused ones', async () => {
    const destination = await division();
    const referenced = await patch('positions', ids.position, {
      expectedVersion: 1,
      divisionId: destination.body.id,
    }).expect(409);
    expect(referenced.body.code).toBe('POSITION_IN_USE');
    const unused = await position(ids.division);
    const moved = await patch('positions', unused.body.id, {
      expectedVersion: 1,
      divisionId: destination.body.id,
    }).expect(200);
    expect(moved.body.division.id).toBe(destination.body.id);
    await patch('divisions', destination.body.id, {
      expectedVersion: 1,
      status: 'INACTIVE',
    }).expect(200);
    const denied = await post('positions', {
      code: prefix + 'NEW',
      name: 'New',
      divisionId: destination.body.id,
      status: 'ACTIVE',
    }).expect(422);
    expect(denied.body.code).toBe('DIVISION_INACTIVE');
  });

  it('preserves inactive historical references and does not cascade deactivation', async () => {
    await patch('divisions', ids.division, {
      expectedVersion: 1,
      status: 'INACTIVE',
    }).expect(200);
    const p = await patch('positions', ids.position, {
      expectedVersion: 1,
      name: 'Still readable',
    }).expect(200);
    expect(p.body.status).toBe('ACTIVE');
    expect(p.body.division.id).toBe(ids.division);
    const e = await source.manager.findOneByOrFail(EmployeeEntity, {
      id: ids.employee,
    });
    expect(e.divisionId).toBe(ids.division);
    await patch('positions', ids.position, {
      expectedVersion: 2,
      status: 'INACTIVE',
    }).expect(200);
    const denied = await patch('positions', ids.position, {
      expectedVersion: 3,
      status: 'ACTIVE',
    }).expect(422);
    expect(denied.body.code).toBe('DIVISION_INACTIVE');
  });

  it('filters before pagination, escapes search wildcards and uses stable code order', async () => {
    await division({ code: prefix + 'B', name: '50% team' });
    await division({ code: prefix + 'A', name: 'Team_A' });
    await division({ code: prefix + 'C', status: 'INACTIVE' });
    const list = await request(app.getHttpServer())
      .get('/api/v1/hr/divisions')
      .set('Authorization', hr)
      .query({ q: prefix, status: 'ACTIVE', pageSize: 1 })
      .expect(200);
    expect(list.body.pagination).toEqual({
      page: 1,
      pageSize: 1,
      totalItems: 2,
      totalPages: 2,
    });
    expect(list.body.items[0].code).toBe(prefix + 'A');
    const literal = await request(app.getHttpServer())
      .get('/api/v1/hr/divisions')
      .set('Authorization', hr)
      .query({ q: '%' })
      .expect(200);
    expect(literal.body.pagination.totalItems).toBe(1);
    expect(literal.body.items[0].name).toBe('50% team');
    const filtered = await request(app.getHttpServer())
      .get('/api/v1/hr/positions')
      .set('Authorization', hr)
      .query({ divisionId: randomUUID() })
      .expect(200);
    expect(filtered.body.items).toEqual([]);
    expect(filtered.body.pagination.totalPages).toBe(0);
  });

  it('enforces HRD access from issued claims without account revocation reads', async () => {
    await request(app.getHttpServer()).get('/api/v1/hr/divisions').expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/hr/divisions')
      .set('Authorization', employee)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/hr/divisions')
      .set('Authorization', employee)
      .send({})
      .expect(403);
    await source.manager.update(
      EmployeeEntity,
      { id: ids.otherEmployee },
      { status: 'INACTIVE' },
    );
    await request(app.getHttpServer())
      .get('/api/v1/hr/positions')
      .set('Authorization', hr)
      .expect(200);
  });

  it('rejects malformed queries, unsupported fields, empty PATCHes and missing keys', async () => {
    const body = { code: prefix, name: 'Division', status: 'ACTIVE' };
    await request(app.getHttpServer())
      .post('/api/v1/hr/divisions')
      .set('Authorization', hr)
      .send(body)
      .expect(400);

    for (const extra of [
      { code: 'X'.repeat(41) },
      { name: '  ' },
      { description: 'x'.repeat(1001) },
      { extra: true },
    ]) {
      await post('divisions', { ...body, ...extra }).expect(400);
    }

    await patch('divisions', ids.division, { expectedVersion: 1 }).expect(400);
    await patch('divisions', ids.division, {
      expectedVersion: 1,
      name: null,
    }).expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/hr/divisions')
      .set('Authorization', hr)
      .query({ page: '01' })
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/v1/hr/positions')
      .set('Authorization', hr)
      .query({ divisionId: 'invalid' })
      .expect(400);
  });
});
