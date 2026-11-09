import { randomUUID } from 'node:crypto';

import { In } from 'typeorm';

import { HolidayRepository } from '../src/holidays/holiday.repository';
import {
  CalendarStateEntity,
  HolidayCalendarEntity,
  HolidayEntity,
  AttendanceEntity,
} from '../src/database/entities';

import { holidayRequests, gate } from './holiday-fixture';
import {
  scheduleApps,
  scheduleAccounts,
  cleanupSchedules,
} from './schedule-fixture';

describe('holiday calendar coordination', () => {
  let apps: Awaited<ReturnType<typeof scheduleApps>>;
  let ids: Awaited<ReturnType<typeof scheduleAccounts>>;
  let hr: string;
  const { batch, post, schedule } = holidayRequests(
    () => apps,
    () => hr,
  );

  beforeAll(async () => {
    apps = await scheduleApps();
    expect(await apps.source.manager.count(HolidayCalendarEntity)).toBe(0);
  });

  beforeEach(async () => {
    apps.clock.value = new Date('2026-11-09T01:00:00Z');
    ids = await scheduleAccounts(apps.source);
    hr = await apps.token(ids.employee);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await apps.source.manager.delete(HolidayEntity, { year: In([2026, 2027]) });
    await apps.source.manager.delete(HolidayCalendarEntity, {
      year: In([2026, 2027]),
    });
    await cleanupSchedules(apps.source, ids);
  });

  afterAll(async () => {
    await apps?.close();
  });

  it('serializes actual schedule and holiday commands without losing a global version', async () => {
    await schedule().expect(200);
    const results = await Promise.allSettled([
      schedule({
        expectedVersion: 1,
        startTime: '09:00',
        endTime: '17:00',
      }).then((res) => res),
      post('changes').then((res) => res),
    ]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const responses = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    expect(responses[1].status).toBe(200);
    expect([200, 409]).toContain(responses[0].status);
    const global = await apps.source.manager.findOneByOrFail(
      CalendarStateEntity,
      { id: 1 },
    );
    expect(global.version).toBe(responses[0].status === 200 ? 3 : 2);
    expect(
      (
        await apps.source.manager.findOneByOrFail(HolidayCalendarEntity, {
          year: 2026,
        })
      ).version,
    ).toBe(1);
  });

  it('preserves recorded attendance snapshots when today becomes a holiday or is removed', async () => {
    const saved = await schedule().expect(200);
    const attendanceId = randomUUID();
    await apps.source.manager.insert(AttendanceEntity, {
      id: attendanceId,
      employeeId: ids.employee,
      workDate: '2026-11-09',
      scheduleVersionId: saved.body.schedule.current.id,
      timeZone: 'Asia/Jakarta',
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
    await post('changes').expect(200);
    expect(
      await apps.source.manager.findOneByOrFail(AttendanceEntity, {
        id: attendanceId,
      }),
    ).toEqual(snapshot);
    await post(
      'changes',
      batch({ expectedVersion: 1, upsert: [], remove: ['2026-11-09'] }),
    ).expect(200);
    expect(
      await apps.source.manager.findOneByOrFail(AttendanceEntity, {
        id: attendanceId,
      }),
    ).toEqual(snapshot);
  });

  it('captures the current date after a real lock wait crossing local midnight', async () => {
    apps.clock.value = new Date('2026-11-09T16:59:59Z');
    hr = await apps.token(ids.employee);
    await schedule().expect(200);
    const runner = apps.source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.manager.findOneOrFail(CalendarStateEntity, {
      where: { id: 1 },
      lock: { mode: 'pessimistic_write' },
    });
    const attempted = gate();
    const repository = apps.attendance.get(HolidayRepository);
    const original = repository.lock.bind(repository);
    jest.spyOn(repository, 'lock').mockImplementation((manager) => {
      attempted.resolve();
      return original(manager);
    });
    const pending = post('changes').then((res) => res);

    try {
      await attempted.promise;
      apps.clock.value = new Date('2026-11-09T17:00:00Z');
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
    expect(
      (
        await apps.source.manager.findOneByOrFail(CalendarStateEntity, {
          id: 1,
        })
      ).version,
    ).toBe(1);
  });
});
