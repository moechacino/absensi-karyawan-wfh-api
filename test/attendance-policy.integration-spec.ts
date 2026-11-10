import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AttendanceEntity } from '../src/database/entities';
import { attendanceApps } from './attendance-fixture';
import type { AttendanceApps } from './attendance-fixture';

describe('HR check-in policy and missed check-out over HTTP/TCP/MySQL', () => {
  let apps: AttendanceApps;

  beforeAll(async () => {
    apps = await attendanceApps();
  });
  beforeEach(async () => {
    await apps.reset();
  });
  afterEach(async () => {
    await apps?.clean();
  });
  afterAll(async () => {
    await apps?.close();
  });

  it('saves HR early allowance, respects the exact boundary and pins it in the snapshot', async () => {
    await request(apps.base)
      .put('/api/v1/hr/work-schedule')
      .set('Authorization', apps.hr)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedVersion: 0,
        workingDays: [1, 2, 3, 4, 5],
        startTime: '20:00',
        endTime: '04:00',
        endDayOffset: 1,
        timeZone: 'Asia/Jakarta',
        effectiveFrom: '2026-11-09',
        opensMinutesBeforeStart: 30,
      })
      .expect(200);
    await apps.setTime('2026-11-09T12:29:59.999Z');
    await apps.checkIn().expect(409);
    await apps.setTime('2026-11-09T12:30:00.000Z');
    const first = await apps.checkIn().expect(201);
    expect(first.body).toMatchObject({
      workDate: '2026-11-09',
      punctuality: 'ON_TIME',
      schedule: {
        opensMinutesBeforeStart: 30,
        plannedStartAt: '2026-11-09T13:00:00.000Z',
        plannedEndAt: '2026-11-09T21:00:00.000Z',
      },
    });
    await apps.setTime('2026-11-09T18:00:00.000Z');
    expect((await apps.home()).body).toMatchObject({
      companyDate: '2026-11-10',
      day: { workDate: '2026-11-09', status: 'WORKING', canCheckOut: true },
    });
    expect(
      (await apps.checkOut(first.body.id).expect(200)).body.schedule,
    ).toEqual(first.body.schedule);
  });

  it('allows overtime checkout and expires the old attendance at the next opening without GET writes', async () => {
    const first = await apps.checkIn().expect(201);
    await apps.setTime('2026-11-09T09:00:00.000Z');
    expect((await apps.home()).body.day).toMatchObject({
      status: 'WORKING',
      canCheckOut: true,
    });
    await apps.setTime('2026-11-10T00:44:59.999Z');
    expect((await apps.home()).body.day).toMatchObject({
      workDate: '2026-11-09',
      status: 'WORKING',
      canCheckOut: true,
    });
    await apps.setTime('2026-11-10T00:45:00.000Z');
    expect((await apps.home()).body.day).toMatchObject({
      workDate: '2026-11-10',
      canCheckIn: true,
    });
    await request(apps.base)
      .get('/api/v1/me/attendances/' + first.body.id)
      .set('Authorization', apps.owner)
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          state: 'MISSED_CHECK_OUT',
          checkOutAt: null,
          durationSeconds: null,
        }),
      );
    expect(
      (
        await apps.source.manager.findOneByOrFail(AttendanceEntity, {
          id: first.body.id,
        })
      ).missedCheckOut,
    ).toBe(false);
    await apps
      .checkOut(first.body.id)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('MISSED_CHECK_OUT'));
    const monitor = await request(apps.base)
      .get('/api/v1/hr/attendance-days?date=2026-11-09&status=MISSED_CHECK_OUT')
      .set('Authorization', apps.hr)
      .expect(200);
    expect(monitor.body.summary.missedCheckOut).toBe(1);
    expect(monitor.body.items[0].day.status).toBe('MISSED_CHECK_OUT');
    await apps.setTime('2026-11-10T01:00:00.000Z');
    const attempts = await Promise.all([apps.checkIn(), apps.checkIn()]);
    expect(attempts.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    const old = await apps.source.manager.findOneByOrFail(AttendanceEntity, {
      id: first.body.id,
    });
    expect(old).toMatchObject({
      missedCheckOut: true,
      checkOutAt: null,
      durationSeconds: null,
      version: 2,
    });
    expect(
      await apps.source.manager.countBy(AttendanceEntity, {
        employeeId: apps.ids.employee,
      }),
    ).toBe(2);
  });

  it('revalidates the published next shift while keeping the original planned end and work date', async () => {
    const first = await apps.checkIn().expect(201);
    await request(apps.base)
      .put('/api/v1/hr/work-schedule')
      .set('Authorization', apps.hr)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedVersion: 0,
        workingDays: [1, 2, 3, 4, 5],
        startTime: '09:00',
        endTime: '17:00',
        endDayOffset: 0,
        timeZone: 'Asia/Jakarta',
        effectiveFrom: '2026-11-10',
        opensMinutesBeforeStart: 30,
      })
      .expect(200);
    await apps.setTime('2026-11-10T01:00:00.000Z');
    expect((await apps.home()).body.day).toMatchObject({
      status: 'WORKING',
      canCheckOut: true,
      attendance: { checkOutDeadlineAt: '2026-11-10T01:30:00.000Z' },
    });
    const closed = await apps.checkOut(first.body.id).expect(200);
    expect(closed.body).toMatchObject({
      workDate: first.body.workDate,
      schedule: first.body.schedule,
      checkOutPunctuality: 'LATE',
    });
  });

  it.each([
    ['2026-11-09T08:00:00.000Z', 'EARLY', 3600],
    ['2026-11-09T09:00:00.000Z', 'ON_TIME', 0],
    ['2026-11-09T10:00:00.000Z', 'LATE', 0],
    ['2026-11-09T18:00:00.000Z', 'LATE', 0],
  ])(
    'accepts checkout at %s on its original record and labels it %s',
    async (at, label, seconds) => {
      const first = await apps.checkIn().expect(201);
      await apps.setTime(at);
      const result = await apps.checkOut(first.body.id).expect(200);
      expect(result.body).toMatchObject({
        id: first.body.id,
        workDate: '2026-11-09',
        state: 'COMPLETED',
        checkOutPunctuality: label,
        earlyCheckOutSeconds: seconds,
        checkOutAt: at,
      });
    },
  );

  it('rolls back the missed marker/version with a failing new attendance insert', async () => {
    const first = await apps.checkIn().expect(201);
    await apps.setTime('2026-11-10T01:00:00.000Z');
    await apps.source.query(
      "CREATE TRIGGER fail_policy_insert BEFORE INSERT ON attendances FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'policy rollback fixture'",
    );
    try {
      await apps.checkIn().expect(500);
      expect(
        await apps.source.manager.findOneByOrFail(AttendanceEntity, {
          id: first.body.id,
        }),
      ).toMatchObject({ missedCheckOut: false, version: 1, checkOutAt: null });
      expect(
        await apps.source.manager.countBy(AttendanceEntity, {
          employeeId: apps.ids.employee,
        }),
      ).toBe(1);
    } finally {
      await apps.source.query('DROP TRIGGER fail_policy_insert');
    }
    await apps.checkIn().expect(201);
  });
});
