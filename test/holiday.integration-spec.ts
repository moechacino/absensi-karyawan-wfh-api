import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { firstValueFrom, timeout } from 'rxjs';
import { DataSource, In } from 'typeorm';

import { HolidayRepository } from '../src/holidays/holiday.repository';
import { LocalCommandRunner } from '../src/idempotency/local-command-runner.service';
import { ATTENDANCE_PATTERNS as patterns } from '../src/attendance-rpc/rpc.contract';
import { createRpcClient } from '../src/gateway-attendance/rpc.client';
import {
  CalendarStateEntity,
  HolidayEntity,
  HolidayCalendarEntity,
  ScheduleVersionEntity,
  IdempotencyOperationEntity,
} from '../src/database/entities';

import { gate, batchHoliday, holidayRequests } from './holiday-fixture';
import {
  scheduleApps,
  scheduleAccounts,
  cleanupSchedules,
} from './schedule-fixture';

describe('holiday HTTP → TCP → MySQL feature', () => {
  let apps: Awaited<ReturnType<typeof scheduleApps>>;
  let ids: Awaited<ReturnType<typeof scheduleAccounts>>;
  let hr: string;
  let employee: string;

  beforeAll(async () => {
    apps = await scheduleApps();
    expect(await apps.source.manager.count(HolidayCalendarEntity)).toBe(0);
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
    await apps.source.manager.delete(HolidayEntity, { year: In([2026, 2027]) });
    await apps.source.manager.delete(HolidayCalendarEntity, {
      year: In([2026, 2027]),
    });
    await cleanupSchedules(apps.source, ids);
    apps.replies.dropNext = false;
  });

  afterAll(async () => {
    await apps?.close();
  });

  const { batch, get, post, schedule } = holidayRequests(
    () => apps,
    () => hr,
  );

  it('reads version zero without a schedule; preview/save require an active schedule', async () => {
    const empty = await get('?year=2026', employee).expect(200);
    expect(empty.body).toEqual({ year: 2026, version: 0, items: [] });
    await post('preview')
      .expect(409)
      .expect((res) => expect(res.body.code).toBe('SCHEDULE_NOT_CONFIGURED'));
    await post('changes').expect(409);
    await schedule({ effectiveFrom: '2026-11-10' }).expect(200);
    await post('preview').expect(409);
    expect(await apps.source.manager.count(HolidayCalendarEntity)).toBe(0);
  });

  it('adds, renames and removes only listed dates with safe DTOs and bounded read queries', async () => {
    await schedule().expect(200);
    const gatewaySql = jest.spyOn(
      apps.gateway.get(DataSource),
      'createQueryRunner',
    );
    const statements: string[] = [];
    jest
      .spyOn(apps.attendance.get(DataSource).logger, 'logQuery')
      .mockImplementation((sql: string) => {
        statements.push(sql);
      });
    const preview = await post('preview').expect(200);
    expect(preview.body).toEqual({ canApply: true, issues: [] });
    expect(statements.filter((sql) => /^SELECT /i.test(sql))).toHaveLength(3);
    expect(await apps.source.manager.count(IdempotencyOperationEntity)).toBe(1);
    const one = await post(
      'changes',
      batch({
        upsert: [
          ...batch().upsert,
          { date: '2026-12-31', name: 'Year end', category: 'PUBLIC' },
        ],
      }),
    ).expect(200);
    expect(one.body.calendar.version).toBe(1);
    const renamed = await post(
      'changes',
      batch({
        expectedVersion: 1,
        upsert: [{ ...batch().upsert[0], name: 'Renamed', category: 'OTHER' }],
      }),
    ).expect(200);
    expect(renamed.body).toEqual({
      calendar: {
        year: 2026,
        version: 2,
        items: [
          { ...batch().upsert[0], name: 'Renamed', category: 'OTHER' },
          { date: '2026-12-31', name: 'Year end', category: 'PUBLIC' },
        ],
      },
    });
    const removed = await post(
      'changes',
      batch({ expectedVersion: 2, upsert: [], remove: ['2026-11-09'] }),
    ).expect(200);
    expect(removed.body.calendar.items).toEqual([
      { date: '2026-12-31', name: 'Year end', category: 'PUBLIC' },
    ]);
    statements.length = 0;
    expect((await get().expect(200)).body).toEqual(removed.body.calendar);
    expect(statements.filter((sql) => /^SELECT /i.test(sql))).toHaveLength(2);
    expect(gatewaySql).not.toHaveBeenCalled();
    expect(
      (
        await apps.source.manager.findOneByOrFail(CalendarStateEntity, {
          id: 1,
        })
      ).version,
    ).toBe(4);
    expect(
      (
        await request(apps.gateway.getHttpServer())
          .get('/api/v1/work-schedule')
          .set('Authorization', `Bearer ${hr}`)
          .expect(200)
      ).body.version,
    ).toBe(4);
  });

  it.each([
    [{ upsert: [], remove: [] }, 'HOLIDAY_BATCH_INVALID'],
    [{ year: 2027 }, 'HOLIDAY_BATCH_INVALID'],
    [{ upsert: [batchHoliday(), batchHoliday()] }, 'DUPLICATE_DATE'],
    [{ remove: ['2026-11-09'] }, 'DUPLICATE_DATE'],
    [{ upsert: [], remove: ['2026-12-31', '2026-12-31'] }, 'DUPLICATE_DATE'],
    [
      { upsert: [{ ...batchHoliday(), date: '2026-11-08' }] },
      'PAST_DATE_IMMUTABLE',
    ],
  ])(
    'previews issues and rejects %j without partial changes',
    async (extra, code) => {
      await schedule().expect(200);
      const input = batch(extra);
      expect((await post('preview', input).expect(200)).body).toMatchObject({
        canApply: false,
        issues: expect.arrayContaining([expect.objectContaining({ code })]),
      });
      await post('changes', input)
        .expect(422)
        .expect((res) => expect(res.body.code).toBe(code));
      expect(await apps.source.manager.count(HolidayCalendarEntity)).toBe(0);
      expect(await apps.source.manager.count(HolidayEntity)).toBe(0);
    },
  );

  it('keeps annual versions independent and rejects stale saves', async () => {
    await schedule().expect(200);
    await post('changes').expect(200);
    await post(
      'changes',
      batch({
        year: 2027,
        upsert: [{ ...batch().upsert[0], date: '2027-01-01' }],
      }),
    ).expect(200);
    expect((await get('?year=2027').expect(200)).body.version).toBe(1);
    expect((await post('preview').expect(200)).body.issues[0].code).toBe(
      'VERSION_CONFLICT',
    );
    await post('changes')
      .expect(409)
      .expect((res) =>
        expect(res.body.details).toEqual({
          expectedVersion: 0,
          actualVersion: 1,
        }),
      );
  });

  it('serializes same-version races, including first creation of an annual calendar', async () => {
    await schedule().expect(200);
    const results = await Promise.allSettled([
      post('changes').then((res) => res),
      post(
        'changes',
        batch({ upsert: [{ ...batch().upsert[0], name: 'Other' }] }),
      ).then((res) => res),
    ]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    expect(
      results
        .flatMap((result) =>
          result.status === 'fulfilled' ? [result.value.status] : [],
        )
        .sort((a, b) => a - b),
    ).toEqual([200, 409]);
    expect(await apps.source.manager.count(HolidayEntity)).toBe(1);
    expect((await get().expect(200)).body.version).toBe(1);
    expect(await apps.source.manager.count(IdempotencyOperationEntity)).toBe(2);
  });

  it('rolls back removed rows, annual/global versions and receipt if an upsert fails', async () => {
    await schedule().expect(200);
    await post('changes').expect(200);
    const repository = apps.attendance.get(HolidayRepository);
    const apply = repository.apply.bind(repository);
    jest
      .spyOn(repository, 'apply')
      .mockImplementation((input, version, global, manager) => {
        const upsert = manager.upsert.bind(manager);
        jest.spyOn(manager, 'upsert').mockImplementationOnce(async () => {
          throw new Error('test-only failure after delete');
        });
        return apply(input, version, global, manager).finally(() => {
          manager.upsert = upsert;
        });
      });
    await post(
      'changes',
      batch({
        expectedVersion: 1,
        upsert: [{ ...batch().upsert[0], date: '2026-12-31' }],
        remove: ['2026-11-09'],
      }),
    ).expect(503);
    expect((await get().expect(200)).body).toEqual({
      year: 2026,
      version: 1,
      items: batch().upsert,
    });
    expect(
      (
        await apps.source.manager.findOneByOrFail(CalendarStateEntity, {
          id: 1,
        })
      ).version,
    ).toBe(2);
    expect(await apps.source.manager.count(IdempotencyOperationEntity)).toBe(2);
  });

  it('replays sorted batches after a lost committed reply and after the dates become past', async () => {
    await schedule().expect(200);
    const key = randomUUID();
    const input = batch({
      upsert: [
        ...batch().upsert,
        { date: '2026-12-01', name: 'Extra', category: 'PUBLIC' },
      ],
      remove: ['2026-12-30', '2026-12-31'],
    });
    apps.replies.pattern = patterns.holidaysChange;
    apps.replies.dropNext = true;
    await post('changes', input, key)
      .expect(503)
      .expect((res) =>
        expect(res.body.code).toBe('ATTENDANCE_OUTCOME_UNKNOWN'),
      );
    apps.clock.value = new Date('2026-11-10T01:00:00Z');
    hr = await apps.token(ids.employee);
    await post(
      'changes',
      {
        ...input,
        upsert: input.upsert.toReversed(),
        remove: input.remove.toReversed(),
      },
      key,
    )
      .expect(200)
      .expect('Idempotency-Replayed', 'true');
    await post('changes', batch(), key)
      .expect(422)
      .expect((res) => expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED'));
    expect((await get().expect(200)).body.version).toBe(1);
    expect(await apps.source.manager.count(IdempotencyOperationEntity)).toBe(2);
  });

  it('authorizes and validates HTTP and raw RPC before the runner, including replay', async () => {
    await schedule().expect(200);
    const key = randomUUID();
    await post('changes', batch(), key).expect(200);
    const commands = jest.spyOn(apps.attendance.get(LocalCommandRunner), 'run');
    await get('?year=2026&year=2027').expect(400);
    await get('?year=2026junk').expect(400);
    await get('').expect(400);
    await post('changes', batch(), key, employee).expect(403);
    await post('preview', batch(), key, employee).expect(403);
    await post('changes', batch({ expectedVersion: '1' })).expect(400);
    await post(
      'changes',
      batch({ upsert: [{ ...batch().upsert[0], date: '2026-02-30' }] }),
    ).expect(400);
    const raw = createRpcClient(apps.config);

    try {
      for (const [token, input, code] of [
        [employee, batch(), 'RPC_FORBIDDEN'],
        [hr, batch({ year: '2026' }), 'RPC_VALIDATION_FAILED'],
      ] as const) {
        await expect(
          firstValueFrom(
            raw
              .send(patterns.holidaysChange, {
                version: 1,
                requestId: randomUUID(),
                serviceCredential: apps.config.serviceCredential,
                accessToken: token,
                idempotencyKey: key,
                input,
              })
              .pipe(timeout(1000)),
          ),
        ).rejects.toMatchObject({ code });
      }
    } finally {
      raw.close();
    }

    expect(commands).not.toHaveBeenCalled();
  });

  it('rechecks the active timezone after waiting on the same calendar lock as schedule/check-in', async () => {
    apps.clock.value = new Date('2026-11-09T11:30:00Z');
    hr = await apps.token(ids.employee);
    await schedule({ timeZone: 'Pacific/Honolulu' }).expect(200);
    await post('preview')
      .expect(200)
      .expect((res) => expect(res.body.canApply).toBe(true));
    const runner = apps.source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.manager.findOneOrFail(CalendarStateEntity, {
      where: { id: 1 },
      lock: { mode: 'pessimistic_write' },
    });
    const attempted = gate();
    const repository = apps.attendance.get(HolidayRepository);
    const lock = repository.lock.bind(repository);
    jest.spyOn(repository, 'lock').mockImplementation((manager) => {
      attempted.resolve();
      return lock(manager);
    });
    const pending = post('changes').then((res) => res);

    try {
      await attempted.promise;
      // Simulate a coordinated schedule update while the holiday save waits.
      await runner.manager.update(
        ScheduleVersionEntity,
        { createdBy: ids.employee },
        { timeZone: 'Pacific/Kiritimati' },
      );
      await runner.manager.update(
        CalendarStateEntity,
        { id: 1 },
        { version: 2 },
      );
      await runner.commitTransaction();
      const response = await pending;
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('PAST_DATE_IMMUTABLE');
    } finally {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }

      await runner.release();
      await Promise.allSettled([pending]);
    }

    expect(await apps.source.manager.count(HolidayEntity)).toBe(0);
  });

  it('uses active zone across midnight and future activation; never guesses UTC', async () => {
    apps.clock.value = new Date('2026-12-31T10:30:00Z');
    hr = await apps.token(ids.employee);
    await schedule({
      timeZone: 'Pacific/Honolulu',
      effectiveFrom: '2026-12-31',
    }).expect(200);
    await schedule({
      expectedVersion: 1,
      timeZone: 'Pacific/Kiritimati',
      effectiveFrom: '2027-01-02',
    }).expect(200);
    const input = batch({
      upsert: [{ ...batch().upsert[0], date: '2026-12-31' }],
    });
    await post('changes', input).expect(200);
    apps.clock.value = new Date('2027-01-01T10:00:00Z');
    hr = await apps.token(ids.employee);
    await post('preview', batch({ ...input, expectedVersion: 1 }))
      .expect(200)
      .expect((res) =>
        expect(res.body.issues[0].code).toBe('PAST_DATE_IMMUTABLE'),
      );
    await post(
      'changes',
      batch({
        year: 2027,
        upsert: [{ ...batch().upsert[0], date: '2027-01-02' }],
      }),
    ).expect(200);
  });

  it('scopes service outage errors and resumes after restart', async () => {
    await apps.attendance.close();

    try {
      await get()
        .expect(503)
        .expect((res) =>
          expect(res.body.code).toBe('ATTENDANCE_SERVICE_UNAVAILABLE'),
        );
      await post('changes')
        .expect(503)
        .expect((res) =>
          expect(res.body.code).toBe('ATTENDANCE_OUTCOME_UNKNOWN'),
        );
      await request(apps.gateway.getHttpServer())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${employee}`)
        .expect(200);
    } finally {
      await apps.startAttendance();
    }

    await get().expect(200);
  });
});
