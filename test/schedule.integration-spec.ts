import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { firstValueFrom, timeout } from 'rxjs';
import { DataSource } from 'typeorm';

import { LocalCommandRunner } from '../src/idempotency/local-command-runner.service';
import { ScheduleRepository } from '../src/work-schedule/schedule.repository';
import { ATTENDANCE_PATTERNS as patterns } from '../src/attendance-rpc/rpc.contract';
import { createRpcClient } from '../src/gateway-attendance/rpc.client';
import {
  ScheduleVersionEntity,
  ScheduleEventEntity,
  CalendarStateEntity,
  IdempotencyOperationEntity,
  AttendanceEntity,
} from '../src/database/entities';

import {
  scheduleApps,
  scheduleAccounts,
  cleanupSchedules,
} from './schedule-fixture';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

describe('work schedule HTTP → TCP → MySQL feature', () => {
  let apps: Awaited<ReturnType<typeof scheduleApps>>;
  let ids: Awaited<ReturnType<typeof scheduleAccounts>>;
  let hr: string;
  let employee: string;

  beforeAll(async () => {
    apps = await scheduleApps();
  });

  beforeEach(async () => {
    apps.clock.value = new Date('2026-11-09T01:00:00.123Z');
    ids = await scheduleAccounts(apps.source);
    [hr, employee] = await Promise.all([
      apps.token(ids.employee),
      apps.token(ids.employee, 'EMPLOYEE'),
    ]);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await cleanupSchedules(apps.source, ids);
    apps.replies.dropNext = false;
  });

  afterAll(async () => {
    await apps?.close();
  });

  function body(extra: object = {}) {
    return {
      expectedVersion: 0,
      workingDays: [1, 2, 3, 4, 5],
      startTime: '08:00',
      endTime: '16:00',
      endDayOffset: 0,
      timeZone: 'Asia/Jakarta',
      effectiveFrom: '2026-11-09',
      ...extra,
    };
  }

  function get(path = '/work-schedule', token = hr) {
    return request(apps.gateway.getHttpServer())
      .get('/api/v1' + path)
      .set('Authorization', `Bearer ${token}`);
  }

  function put(input = body(), key: string = randomUUID(), token = hr) {
    return request(apps.gateway.getHttpServer())
      .put('/api/v1/hr/work-schedule')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send(input);
  }

  function preview(input = body(), token = hr) {
    return request(apps.gateway.getHttpServer())
      .post('/api/v1/hr/work-schedule/preview')
      .set('Authorization', `Bearer ${token}`)
      .send(input);
  }

  it('serves all five operations over actual TCP and preserves public DTOs without gateway SQL', async () => {
    const queries = jest.spyOn(
      apps.gateway.get(DataSource),
      'createQueryRunner',
    );
    const sql: string[] = [];
    jest
      .spyOn(apps.attendance.get(DataSource).logger, 'logQuery')
      .mockImplementation((statement: string) => {
        sql.push(statement);
      });
    const empty = await get('/work-schedule', employee).expect(200);
    expect(sql.filter((statement) => /^SELECT /i.test(statement))).toHaveLength(
      2,
    );
    const zones = await get(
      '/reference/time-zones?q=Jakarta&atDate=2026-11-16',
      employee,
    ).expect(200);
    const advisory = await preview().expect(200);
    const saved = await put().expect(200);
    sql.length = 0;
    const history = await get(
      '/hr/work-schedule/versions?page=1&pageSize=1',
    ).expect(200);

    expect(empty.body).toEqual({
      version: 0,
      current: null,
      upcoming: null,
      checkInPolicy: { opensMinutesBeforeStart: 15, lateAfterMinutes: 0 },
    });
    expect(zones.body.items[0]).toMatchObject({
      id: 'Asia/Jakarta',
      offsetMinutes: 420,
    });
    expect(advisory.body).toMatchObject({
      activationMode: 'ON_SAVE',
      effectiveAt: null,
      comparisonDate: '2026-11-09',
      impact: { canApply: true, issues: [] },
    });
    expect(saved.body.schedule).toMatchObject({
      version: 1,
      current: {
        state: 'ACTIVE',
        createdBy: { id: ids.employee, fullName: 'Fixture employee' },
      },
      upcoming: null,
    });
    expect(history.body).toMatchObject({
      items: [{ id: saved.body.schedule.current.id, state: 'ACTIVE' }],
      pagination: { page: 1, pageSize: 1, totalItems: 1, totalPages: 1 },
    });
    expect(
      JSON.stringify([
        empty.body,
        zones.body,
        advisory.body,
        saved.body,
        history.body,
      ]),
    ).not.toMatch(/initialPassword|passwordHash|reconciliation|balanceImpacts/);
    expect(sql.filter((statement) => /^SELECT /i.test(statement))).toHaveLength(
      4,
    );
    expect(sql.join(' ')).not.toMatch(/initial_password|password_hash/i);
    expect(queries).not.toHaveBeenCalled();
    expect(await apps.source.manager.count(ScheduleEventEntity)).toBe(1);
  });

  it('replaces future and immediate schedules while retaining history and committed snapshots', async () => {
    const first = await put().expect(200);
    const original = first.body.schedule.current;
    const attendanceId = randomUUID();
    await apps.source.manager.insert(AttendanceEntity, {
      id: attendanceId,
      employeeId: ids.employee,
      workDate: '2026-11-09',
      scheduleVersionId: original.id,
      timeZone: original.timeZone,
      plannedStartAt: new Date('2026-11-09T01:00:00Z'),
      plannedEndAt: new Date('2026-11-09T09:00:00Z'),
      checkInAt: new Date('2026-11-09T01:00:00Z'),
      punctuality: 'ON_TIME',
      photoFileId: ids.file,
    });
    const snapshot = await apps.source.manager.findOneByOrFail(
      AttendanceEntity,
      { id: attendanceId },
    );
    const future = await put(
      body({
        expectedVersion: 1,
        timeZone: 'Asia/Makassar',
        effectiveFrom: '2026-11-16',
      }),
    ).expect(200);
    const canceledId = future.body.schedule.upcoming.id;
    expect(future.body.schedule.upcoming.effectiveAt).toBe(
      '2026-11-15T16:00:00.000Z',
    );
    const replacement = await put(
      body({ expectedVersion: 2, effectiveFrom: '2026-11-20' }),
    ).expect(200);

    expect(replacement.body.schedule.current.id).toBe(original.id);
    expect(replacement.body.schedule.upcoming.effectiveAt).toBe(
      '2026-11-19T17:00:00.000Z',
    );
    const canceled = await apps.source.manager.findOneByOrFail(
      ScheduleVersionEntity,
      { id: canceledId },
    );
    expect(canceled.supersededAt!.getTime()).toBeLessThan(
      canceled.effectiveAt.getTime(),
    );
    const immediate = await put(
      body({ expectedVersion: 3, startTime: '09:00', endTime: '17:00' }),
    ).expect(200);
    expect(immediate.body.schedule).toMatchObject({
      version: 4,
      current: { startTime: '09:00', state: 'ACTIVE' },
      upcoming: null,
    });
    const history = await get(
      '/hr/work-schedule/versions?page=1&pageSize=2',
    ).expect(200);
    expect(history.body.pagination).toEqual({
      page: 1,
      pageSize: 2,
      totalItems: 4,
      totalPages: 2,
    });
    expect(history.body.items).toHaveLength(2);
    expect(
      history.body.items.every(
        (item: { state: string }) => item.state === 'SUPERSEDED',
      ),
    ).toBe(true);
    expect(
      await apps.source.manager.findOneByOrFail(AttendanceEntity, {
        id: attendanceId,
      }),
    ).toEqual(snapshot);
    expect(await apps.source.manager.count(ScheduleEventEntity)).toBe(7);
    await expect(
      apps.source.manager.update(
        ScheduleEventEntity,
        { calendarVersion: 4 },
        { calendarVersion: 99 },
      ),
    ).rejects.toMatchObject({ driverError: { code: 'ER_SIGNAL_EXCEPTION' } });
  });

  it('activates a future version at its exact instant without changing resource version or history on GET', async () => {
    await put(
      body({ timeZone: 'Asia/Makassar', effectiveFrom: '2026-11-16' }),
    ).expect(200);
    apps.clock.value = new Date('2026-11-15T15:59:59.999Z');
    hr = await apps.token(ids.employee);
    const before = await get().expect(200);
    expect(before.body).toMatchObject({
      version: 1,
      current: null,
      upcoming: { state: 'SCHEDULED' },
    });
    apps.clock.value = new Date('2026-11-15T16:00:00Z');
    const after = await get().expect(200);

    expect(after.body).toMatchObject({
      version: 1,
      current: { timeZone: 'Asia/Makassar', state: 'ACTIVE' },
      upcoming: null,
    });
    expect(await apps.source.manager.count(ScheduleEventEntity)).toBe(1);
  });

  it('serializes different-key competing saves using calendar_state, admitting exactly one expected version', async () => {
    const responses = await Promise.allSettled([
      put(body()),
      put(body({ timeZone: 'Asia/Makassar' })),
    ]);
    expect(responses.every((result) => result.status === 'fulfilled')).toBe(
      true,
    );
    const statuses = responses
      .map((result) =>
        result.status === 'fulfilled' ? result.value.status : 0,
      )
      .sort((a, b) => a - b);

    expect(statuses).toEqual([200, 409]);
    expect(
      (
        await apps.source.manager.findOneByOrFail(CalendarStateEntity, {
          id: 1,
        })
      ).version,
    ).toBe(1);
    expect(await apps.source.manager.count(ScheduleVersionEntity)).toBe(1);
    expect(await apps.source.manager.count(ScheduleEventEntity)).toBe(1);
    expect(await apps.source.manager.count(IdempotencyOperationEntity)).toBe(1);
  });

  it('rolls back schedule, resource version and receipt when append-only event persistence fails', async () => {
    jest
      .spyOn(apps.attendance.get(ScheduleRepository), 'appendEvents')
      .mockRejectedValueOnce(new Error('private SQL failure marker'));
    const response = await put().expect(503);

    expect(response.body.code).toBe('ATTENDANCE_OUTCOME_UNKNOWN');
    expect(JSON.stringify(response.body)).not.toContain(
      'private SQL failure marker',
    );
    expect(
      (
        await apps.source.manager.findOneByOrFail(CalendarStateEntity, {
          id: 1,
        })
      ).version,
    ).toBe(0);
    expect(await apps.source.manager.count(ScheduleVersionEntity)).toBe(0);
    expect(await apps.source.manager.count(ScheduleEventEntity)).toBe(0);
    expect(await apps.source.manager.count(IdempotencyOperationEntity)).toBe(0);
  });

  it('replays a committed lost reply with its original key/status/body and no second history effect', async () => {
    const key = randomUUID();
    apps.replies.dropNext = true;
    await put(body(), key)
      .expect(503)
      .expect((response) =>
        expect(response.body.code).toBe('ATTENDANCE_OUTCOME_UNKNOWN'),
      );
    const replay = await put(
      body({ workingDays: [5, 4, 3, 2, 1] }),
      key,
    ).expect(200);

    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body.schedule.version).toBe(1);
    expect(await apps.source.manager.count(ScheduleVersionEntity)).toBe(1);
    expect(await apps.source.manager.count(ScheduleEventEntity)).toBe(1);
    expect(await apps.source.manager.count(IdempotencyOperationEntity)).toBe(1);
    await put(body({ startTime: '09:00' }), key)
      .expect(422)
      .expect((response) =>
        expect(response.body.code).toBe('IDEMPOTENCY_KEY_REUSED'),
      );
  });

  it('authorizes and validates before runner/replay at both HTTP and RPC boundaries', async () => {
    const key = randomUUID();
    await put(body(), key).expect(200);
    const calls = jest.spyOn(apps.attendance.get(LocalCommandRunner), 'run');
    await put(body(), key, employee).expect(403);
    await get('/hr/work-schedule/versions', employee).expect(403);
    await preview(body(), employee).expect(403);
    await get('/hr/work-schedule/versions?page=01').expect(400);
    await put(body({ extra: true })).expect(400);
    await put(body(), 'invalid').expect(400);
    const raw = createRpcClient(apps.config);

    try {
      await expect(
        firstValueFrom(
          raw
            .send(patterns.scheduleChange, {
              version: 1,
              requestId: randomUUID(),
              serviceCredential: apps.config.serviceCredential,
              accessToken: employee,
              idempotencyKey: key,
              input: body(),
            })
            .pipe(timeout(1000)),
        ),
      ).rejects.toMatchObject({ code: 'RPC_FORBIDDEN' });
      await expect(
        firstValueFrom(
          raw
            .send(patterns.scheduleChange, {
              version: 1,
              requestId: randomUUID(),
              serviceCredential: apps.config.serviceCredential,
              accessToken: hr,
              idempotencyKey: key,
              input: body({ expectedVersion: '0' }),
            })
            .pipe(timeout(1000)),
        ),
      ).rejects.toMatchObject({ code: 'RPC_VALIDATION_FAILED' });
    } finally {
      raw.close();
    }

    expect(calls).not.toHaveBeenCalled();
  });

  it('makes previews advisory, rejects semantic invalidity without invented activation, and replays valid old saves', async () => {
    await preview(body({ endTime: '08:00' }))
      .expect(422)
      .expect((response) =>
        expect(response.body.code).toBe('INVALID_DURATION'),
      );
    await preview(body({ timeZone: 'Unsupported/Zone' })).expect(422);
    await preview(body({ effectiveFrom: '2026-11-08' })).expect(422);
    const key = randomUUID();
    await put(body(), key).expect(200);
    const stale = await preview(body()).expect(200);
    expect(stale.body.impact).toMatchObject({
      canApply: false,
      issues: [{ code: 'VERSION_CONFLICT' }],
    });
    apps.clock.value = new Date('2026-11-10T01:00:00Z');
    hr = await apps.token(ids.employee);
    await put(body(), key).expect(200).expect('Idempotency-Replayed', 'true');
    await put(body({ expectedVersion: 1 }))
      .expect(422)
      .expect((response) =>
        expect(response.body.code).toBe('PAST_DATE_IMMUTABLE'),
      );
  });

  it('revalidates the save-time date after a real calendar lock wait crosses midnight', async () => {
    apps.clock.value = new Date('2026-11-09T16:59:59Z');
    hr = await apps.token(ids.employee);
    await preview().expect(200);
    const runner = apps.source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.manager.findOneOrFail(CalendarStateEntity, {
      where: { id: 1 },
      lock: { mode: 'pessimistic_write' },
    });
    const attempted = gate();
    const repository = apps.attendance.get(ScheduleRepository);
    const original = repository.state.bind(repository);
    jest.spyOn(repository, 'state').mockImplementation((manager, lock) => {
      if (lock) {
        attempted.resolve();
      }

      return original(manager, lock);
    });
    const pending = put().then((response) => response);

    try {
      await attempted.promise;
      apps.clock.value = new Date('2026-11-09T17:00:00Z');
      await runner.commitTransaction();
      expect((await pending).body.code).toBe('PAST_DATE_IMMUTABLE');
    } finally {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }

      await runner.release();
      await Promise.allSettled([pending]);
    }

    expect(await apps.source.manager.count(ScheduleEventEntity)).toBe(0);
    expect(await apps.source.manager.count(IdempotencyOperationEntity)).toBe(0);
  });

  it('keeps service-backed failures declared while auth/profile routes remain available during an outage', async () => {
    await apps.attendance.close();

    try {
      await get()
        .expect(503)
        .expect((response) =>
          expect(response.body.code).toBe('ATTENDANCE_SERVICE_UNAVAILABLE'),
        );
      await put()
        .expect(503)
        .expect((response) =>
          expect(response.body.code).toBe('ATTENDANCE_OUTCOME_UNKNOWN'),
        );
      await get('/me', employee).expect(200);
      await get('/hr/divisions').expect(200);
    } finally {
      await apps.startAttendance();
    }

    await get().expect(200);
  });
});
