import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';

import type { INestMicroservice } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { firstValueFrom, timeout } from 'rxjs';
import request from 'supertest';
import { DataSource, In } from 'typeorm';

import { RPC_CONFIG, parseRpcConfig } from '../src/attendance-rpc/rpc.config';
import { attendanceTcpOptions } from '../src/attendance-rpc/rpc.transport';
import { ATTENDANCE_PATTERNS as patterns } from '../src/attendance-rpc/rpc.contract';
import { AccessTokenService } from '../src/auth/access-token.service';
import { Clock } from '../src/runtime/clock';
import { loadRuntimeConfig } from '../src/runtime/runtime.config';
import { configureHttp } from '../src/http/configure-http';
import { LocalCommandRunner } from '../src/idempotency/local-command-runner.service';
import {
  AttendanceEntity,
  DivisionEntity,
  PositionEntity,
  EmployeeEntity,
  FileObjectEntity,
  ScheduleVersionEntity,
  IdempotencyOperationEntity,
} from '../src/database/entities';
import { createRpcClient } from '../src/gateway-attendance/rpc.client';
import { AttendanceClient } from '../src/gateway-attendance/attendance-client.service';

import {
  GatewayBoundaryProbeModule,
  RpcBoundaryProbeModule,
  ProbeState,
  RpcTestClock,
} from './gateway-rpc.fixture';
import { insertFixture, prepareTestDatabase } from './mysql-fixture';

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  return port;
}

describe('gateway HTTP to attendance RPC boundary with real MySQL', () => {
  let gateway: NestExpressApplication;
  let attendance: INestMicroservice;
  let source: DataSource;
  let config: ReturnType<typeof parseRpcConfig>;
  let state: ProbeState;
  let ids: Awaited<ReturnType<typeof insertFixture>>;
  let recordId: string;
  let token: string;
  let otherToken: string;
  let hrToken: string;
  let serviceClock: RpcTestClock;

  async function startAttendance() {
    serviceClock = new RpcTestClock();

    const module = await Test.createTestingModule({
      imports: [RpcBoundaryProbeModule],
    })
      .overrideProvider(RPC_CONFIG)
      .useValue(config)
      .overrideProvider(Clock)
      .useValue(serviceClock)
      .compile();
    attendance = module.createNestMicroservice({
      ...attendanceTcpOptions(config),
      logger: false,
    });
    await attendance.listen();

    state = attendance.get(ProbeState);
  }

  beforeAll(async () => {
    source = await prepareTestDatabase();
    config = parseRpcConfig({
      ATTENDANCE_RPC_CREDENTIAL: 'gateway-rpc-integration-credential-32-bytes',
      ATTENDANCE_RPC_PORT: String(await freePort()),
      ATTENDANCE_RPC_DEADLINE_MS: '100',
    });
    await startAttendance();

    const module = await Test.createTestingModule({
      imports: [GatewayBoundaryProbeModule],
    })
      .overrideProvider(RPC_CONFIG)
      .useValue(config)
      .compile();
    gateway = module.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    configureHttp(gateway, loadRuntimeConfig());
    await gateway.init();
  });

  beforeEach(async () => {
    ids = await source.transaction(insertFixture);
    recordId = randomUUID();
    await source.manager.insert(AttendanceEntity, {
      id: recordId,
      employeeId: ids.employee,
      workDate: '2026-11-09',
      scheduleVersionId: ids.schedule,
      timeZone: 'Asia/Jakarta',
      plannedStartAt: new Date('2026-11-09T01:00:00Z'),
      plannedEndAt: new Date('2026-11-09T09:00:00Z'),
      checkInAt: new Date('2026-11-09T01:00:00Z'),
      photoFileId: ids.file,
      punctuality: 'ON_TIME',
      lateSeconds: 0,
    });

    const tokens = gateway.get(AccessTokenService);
    [token, otherToken, hrToken] = await Promise.all([
      tokens.issue({ id: ids.employee, role: 'EMPLOYEE' }),
      tokens.issue({ id: ids.otherEmployee, role: 'EMPLOYEE' }),
      tokens.issue({ id: ids.otherEmployee, role: 'HRD' }),
    ]).then((grants) => grants.map((grant) => grant.accessToken));

    state.readDelayMs = 0;
    state.dropNextReply = false;
    serviceClock.offsetMs = 0;
  });

  afterEach(async () => {
    await source.manager.delete(IdempotencyOperationEntity, {
      actorId: In([ids.employee, ids.otherEmployee]),
    });
    await source.manager.delete(AttendanceEntity, { id: recordId });
    await source.manager.delete(ScheduleVersionEntity, { id: ids.schedule });
    await source.manager.delete(FileObjectEntity, { id: ids.file });
    await source.manager.delete(EmployeeEntity, {
      id: In([ids.employee, ids.otherEmployee]),
    });
    await source.manager.delete(PositionEntity, { id: ids.position });
    await source.manager.delete(DivisionEntity, { id: ids.division });

    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await gateway?.close();
    await attendance?.close();
    await source?.destroy();
  });

  function read(q?: string) {
    return request(gateway.getHttpServer())
      .get('/api/v1/rpc-probe/read')
      .set('Authorization', `Bearer ${token}`)
      .query(q ? { q } : {});
  }

  function write(
    key: string,
    input: object = { attendanceId: recordId, expectedVersion: 1 },
    accessToken = token,
  ) {
    return request(gateway.getHttpServer())
      .post('/api/v1/rpc-probe/write')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', key)
      .send(input);
  }

  it('preserves request IDs and maps successful responses without a gateway SQL transaction', async () => {
    const id = randomUUID();
    const gatewayQueries = jest.spyOn(
      gateway.get(DataSource),
      'createQueryRunner',
    );
    const response = await read().set('X-Request-Id', id).expect(200);

    expect(response.body).toEqual({ items: [] });
    expect(response.headers['x-request-id']).toBe(id);
    expect(state.receivedRequestId).toBe(id);
    expect(gatewayQueries).not.toHaveBeenCalled();
  });

  it('commits once, loses the reply, then replays the original key/result without a second effect', async () => {
    const key = randomUUID();
    const gatewayQueries = jest.spyOn(
      gateway.get(DataSource),
      'createQueryRunner',
    );
    state.dropNextReply = true;
    const uncertain = await write(key).expect(503);

    expect(uncertain.body.code).toBe('ATTENDANCE_OUTCOME_UNKNOWN');
    expect(uncertain.body.detail).toContain('original idempotency key');
    expect(state.receivedKey).toBe(key);
    expect(
      (await source.manager.findOneByOrFail(AttendanceEntity, { id: recordId }))
        .version,
    ).toBe(2);
    const replay = await write(key).expect(200);

    expect(replay.body).toEqual({ id: recordId, version: 2 });
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(
      (await source.manager.findOneByOrFail(AttendanceEntity, { id: recordId }))
        .version,
    ).toBe(2);
    expect(
      await source.manager.countBy(IdempotencyOperationEntity, {
        actorId: ids.employee,
      }),
    ).toBe(1);
    expect(gatewayQueries).not.toHaveBeenCalled();
    await write(key, { attendanceId: recordId, expectedVersion: 2 })
      .expect(422)
      .expect((response) =>
        expect(response.body.code).toBe('IDEMPOTENCY_KEY_REUSED'),
      );
  });

  it('checks resource access before fresh and replay receipt lookup, and DTOs before the runner', async () => {
    const key = randomUUID();
    await write(key).expect(200);
    const runner = jest.spyOn(attendance.get(LocalCommandRunner), 'run');
    await write(
      key,
      { attendanceId: recordId, expectedVersion: 1 },
      otherToken,
    ).expect(404);
    await write(randomUUID(), {
      attendanceId: recordId,
      expectedVersion: 2,
      injected: true,
    }).expect(400);

    expect(runner).not.toHaveBeenCalled();
    const raw = createRpcClient(config);

    try {
      await expect(
        firstValueFrom(
          raw
            .send(patterns.checkOut, {
              version: 1,
              requestId: randomUUID(),
              serviceCredential: config.serviceCredential,
              accessToken: token,
              idempotencyKey: key,
              input: { attendanceId: recordId, expectedVersion: '1' },
            })
            .pipe(timeout(1000)),
        ),
      ).rejects.toMatchObject({ code: 'RPC_VALIDATION_FAILED' });
      await expect(
        firstValueFrom(
          raw
            .send(patterns.scheduleChange, {
              version: 1,
              requestId: randomUUID(),
              serviceCredential: config.serviceCredential,
              accessToken: token,
              idempotencyKey: key,
              input: {},
            })
            .pipe(timeout(1000)),
        ),
      ).rejects.toMatchObject({ code: 'RPC_FORBIDDEN' });
    } finally {
      raw.close();
    }

    expect(runner).not.toHaveBeenCalled();
    await source.manager.update(
      AttendanceEntity,
      { id: recordId },
      { employeeId: ids.otherEmployee },
    );
    await write(key).expect(404);
    expect(runner).not.toHaveBeenCalled();
  });

  it('keeps inaccessible records indistinguishable and permits issued HRD claims', async () => {
    const path = `/api/v1/rpc-probe/record/${recordId}`;
    const forbidden = await request(gateway.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
    const missing = await request(gateway.getHttpServer())
      .get(`/api/v1/rpc-probe/record/${randomUUID()}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);

    expect(forbidden.body.code).toBe('NOT_FOUND');
    expect(missing.body.code).toBe(forbidden.body.code);
    await request(gateway.getHttpServer())
      .get(`/api/v1/rpc-probe/hr-record/${recordId}`)
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);
  });

  it('preserves request IDs and Bearer challenges for expiry between HTTP and RPC verification', async () => {
    const id = randomUUID();
    serviceClock.offsetMs = 3601000;
    const runner = jest.spyOn(attendance.get(LocalCommandRunner), 'run');
    const response = await write(randomUUID())
      .set('X-Request-Id', id)
      .expect(401);

    expect(response.body).toMatchObject({
      code: 'TOKEN_EXPIRED',
      requestId: id,
    });
    expect(response.headers['www-authenticate']).toBe(
      'Bearer error="invalid_token"',
    );
    expect(response.headers['x-request-id']).toBe(id);
    expect(runner).not.toHaveBeenCalled();
  });

  it('bounds read waits and sanitizes internal errors', async () => {
    state.readDelayMs = 250;
    await read()
      .expect(503)
      .expect((response) =>
        expect(response.body.code).toBe('ATTENDANCE_SERVICE_TIMEOUT'),
      );
    state.readDelayMs = 0;
    const response = await read('secret').expect(500);

    expect(response.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toContain(
      'private-SQL-JWT-path-marker',
    );
    await new Promise((resolve) => setTimeout(resolve, 260));
  });

  it('maps unknown patterns without parsing Nest exception strings', async () => {
    await expect(
      gateway.get(AttendanceClient).call(patterns.scheduleGet, {
        requestId: randomUUID(),
        accessToken: token,
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'ATTENDANCE_SERVICE_UNAVAILABLE' });
  });

  it('fails safely with service absent, preserves gateway-owned features and reconnects after restart', async () => {
    await attendance.close();
    await read()
      .expect(503)
      .expect((response) =>
        expect(response.body.code).toBe('ATTENDANCE_SERVICE_UNAVAILABLE'),
      );
    await write(randomUUID())
      .expect(503)
      .expect((response) =>
        expect(response.body.code).toBe('ATTENDANCE_OUTCOME_UNKNOWN'),
      );

    await request(gateway.getHttpServer())
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(gateway.getHttpServer())
      .get('/api/v1/hr/divisions')
      .set('Authorization', `Bearer ${hrToken}`)
      .expect(200);

    await startAttendance();
    await read().expect(200);
  });
});
