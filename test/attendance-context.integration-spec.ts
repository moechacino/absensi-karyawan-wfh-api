import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import request from 'supertest';
import {
  EmployeeEntity,
  CalendarStateEntity,
  HolidayCalendarEntity,
  HolidayEntity,
  ScheduleVersionEntity,
} from '../src/database/entities';
import { attendanceApps, control } from './attendance-fixture';
import type { AttendanceApps, AttendanceWritten } from './attendance-fixture';
import { processMessage, queryCounts } from './file-handoff.helpers';

describe('production attendance time boundaries and calendar coordination', () => {
  let apps: AttendanceApps;

  beforeAll(async () => {
    apps = await attendanceApps();
  });
  beforeEach(async () => {
    await apps.reset();
  });
  afterEach(async () => {
    await apps.clean();
  });
  afterAll(async () => {
    await apps?.close();
  });

  it.each([
    ['2026-11-09T00:44:59.999Z', 409, 'CHECK_IN_TOO_EARLY'],
    ['2026-11-09T00:45:00.000Z', 201, 'ON_TIME'],
    ['2026-11-09T01:00:00.000Z', 201, 'ON_TIME'],
    ['2026-11-09T09:00:00.000Z', 409, 'CHECK_IN_WINDOW_CLOSED'],
  ])(
    'uses completed-upload instant %s with millisecond boundaries',
    async (at, status, code) => {
      await apps.setTime(at);
      const home = await apps.home();
      const result = await apps.checkIn().expect(status as number);

      if (status === 201) {
        expect(home.body.day.canCheckIn).toBe(true);
        expect(result.body).toMatchObject({
          checkInAt: at,
          punctuality: code,
          lateSeconds: 0,
        });
      } else {
        expect(home.body.day).toMatchObject({
          canCheckIn: false,
          blockReason: code,
        });
        expect(result.body.code).toBe(code);
        expect(await apps.snapshotCounts()).toEqual({
          records: 0,
          receipts: 0,
          files: 1,
        });
        expect(await readdir(apps.root)).toEqual([]);
      }
    },
  );

  it('rejects a real multipart upload that starts before closing and finishes at closing', async () => {
    await apps.setTime('2026-11-09T08:59:59.999Z');
    const boundary = 'attendance-' + randomUUID();
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`,
    );
    const payload = Buffer.concat([
      prefix,
      apps.png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const split = prefix.length + Math.floor(apps.png.length / 2);
    const upload = httpRequest(apps.base + '/api/v1/me/attendances/check-in', {
      method: 'POST',
      headers: {
        Authorization: apps.owner,
        'Idempotency-Key': randomUUID(),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length,
      },
    });
    const response = new Promise<{ status: number; body: { code: string } }>(
      (resolve, reject) => {
        upload.on('error', reject);
        upload.on('response', (reply) => {
          const chunks: Buffer[] = [];
          reply.on('data', (chunk: Buffer) => chunks.push(chunk));
          reply.on('error', reject);
          reply.on('end', () =>
            resolve({
              status: reply.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString()) as {
                code: string;
              },
            }),
          );
        });
      },
    );

    try {
      await new Promise<void>((resolve, reject) =>
        upload.write(payload.subarray(0, split), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      await apps.setTime('2026-11-09T09:00:00.000Z');
      upload.end(payload.subarray(split));
      expect(await response).toEqual({
        status: 409,
        body: expect.objectContaining({ code: 'CHECK_IN_WINDOW_CLOSED' }),
      });
      expect(await apps.snapshotCounts()).toEqual({
        records: 0,
        receipts: 0,
        files: 1,
      });
      expect(await readdir(apps.root)).toEqual([]);
    } finally {
      upload.destroy();
    }
  });

  it('keeps the upload receipt when an employee lock wait crosses closing time', async () => {
    await apps.setTime('2026-11-09T08:59:59.999Z');
    const runner = apps.source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction('READ COMMITTED');

    try {
      await runner.manager.findOneOrFail(EmployeeEntity, {
        where: { id: apps.ids.employee },
        lock: { mode: 'pessimistic_write' },
      });
      const waiting = processMessage<{ employeeId: string }>(
        apps.attendance,
        'employee-lock-requested',
        (message) => message.employeeId === apps.ids.employee,
      );
      const checkingIn = apps.checkIn().then((result) => result);
      await waiting;
      await apps.setTime('2026-11-09T09:00:00.001Z');
      await runner.commitTransaction();
      const result = await checkingIn;
      expect(result.status).toBe(201);
      expect(result.body.checkInAt).toBe('2026-11-09T08:59:59.999Z');
      expect(await apps.snapshotCounts()).toEqual({
        records: 1,
        receipts: 1,
        files: 2,
      });
      apps.captures.push({ schema: 'Attendance', body: result.body });
    } finally {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }

      await runner.release();
    }
  });

  it.each(['rest', 'holiday', 'unconfigured'])(
    'rejects %s without creating attendance, file metadata or receipt',
    async (kind) => {
      if (kind === 'rest') {
        await apps.source.manager.update(
          ScheduleVersionEntity,
          { id: apps.ids.schedule },
          { workingDays: [2] },
        );
      } else if (kind === 'holiday') {
        await apps.source.manager.insert(HolidayCalendarEntity, {
          year: 2026,
          version: 1,
        });
        await apps.source.manager.insert(HolidayEntity, {
          year: 2026,
          date: '2026-11-09',
          name: 'Company holiday',
          category: 'COMPANY',
        });
      } else {
        await apps.source.manager.delete(ScheduleVersionEntity, {
          id: apps.ids.schedule,
        });
      }

      const home = await apps.home();
      expect(home.body.day).toMatchObject({
        status:
          kind === 'rest'
            ? 'REST_DAY'
            : kind === 'holiday'
              ? 'HOLIDAY'
              : 'UNCONFIGURED',
        canCheckIn: false,
        attendance: null,
      });
      await apps
        .checkIn()
        .expect(409)
        .expect(({ body }) =>
          expect(body.code).toBe(
            kind === 'unconfigured'
              ? 'SCHEDULE_NOT_CONFIGURED'
              : 'ATTENDANCE_NOT_REQUIRED',
          ),
        );
      expect(await apps.snapshotCounts()).toEqual({
        records: 0,
        receipts: 0,
        files: 1,
      });
    },
  );

  it('resolves DST ambiguity only for a required working shift, preserving rest/holiday home', async () => {
    await apps.source.manager.update(
      ScheduleVersionEntity,
      { id: apps.ids.schedule },
      {
        timeZone: 'America/New_York',
        startTime: '01:30',
        endTime: '09:30',
        workingDays: [1],
      },
    );
    await apps.setTime('2026-11-01T07:00:00.000Z');
    expect((await apps.home()).body.day.status).toBe('REST_DAY');
    await apps.source.manager.update(
      ScheduleVersionEntity,
      { id: apps.ids.schedule },
      { workingDays: [1, 2, 3, 4, 5, 6, 7] },
    );
    await apps.source.manager.insert(HolidayCalendarEntity, {
      year: 2026,
      version: 1,
    });
    await apps.source.manager.insert(HolidayEntity, {
      year: 2026,
      date: '2026-11-01',
      name: 'Company day',
      category: 'COMPANY',
    });
    expect((await apps.home()).body.day.status).toBe('HOLIDAY');
    await apps.source.manager.delete(HolidayEntity, {
      year: 2026,
      date: '2026-11-01',
    });
    await request(apps.base)
      .get('/api/v1/me/home')
      .set('Authorization', apps.owner)
      .expect(422)
      .expect(({ body }) => expect(body.code).toBe('INVALID_LOCAL_TIME'));
    await apps.checkIn().expect(422);
    expect(await apps.snapshotCounts()).toEqual({
      records: 0,
      receipts: 0,
      files: 1,
    });
  });

  it('preserves year-end overnight precedence and checkout snapshot across a timezone change', async () => {
    await apps.source.manager.update(
      ScheduleVersionEntity,
      { id: apps.ids.schedule },
      { startTime: '22:00', endTime: '06:00', endDayOffset: 1 },
    );
    await apps.setTime('2026-12-31T15:00:00.000Z');
    const first = await apps.checkIn().expect(201);
    expect(first.body.workDate).toBe('2026-12-31');
    await apps.setTime('2026-12-31T18:00:00.000Z');
    const nextDate = await apps.home();
    expect(nextDate.body).toMatchObject({
      companyDate: '2027-01-01',
      day: { workDate: '2026-12-31', status: 'WORKING', canCheckOut: true },
    });
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
        timeZone: 'America/New_York',
        effectiveFrom: '2026-12-31',
      })
      .expect(200);
    const changed = await apps.home();
    expect(changed.body.timeZone).toBe('America/New_York');
    expect(changed.body.day.attendance.schedule).toEqual(first.body.schedule);
    const closed = await apps.checkOut(first.body.id).expect(200);
    expect(closed.body.schedule).toEqual(first.body.schedule);
    expect(closed.body.durationSeconds).toBe(10800);
    apps.captures.push({ schema: 'Attendance', body: closed.body });
  });

  it.each(['schedule', 'holiday'])(
    'orders a concurrent %s save behind an uncommitted check-in',
    async (kind) => {
      await control(apps.attendance, { hold: true });
      const written = processMessage<AttendanceWritten>(
        apps.attendance,
        'attendance-written',
        (message) => message.employeeId === apps.ids.employee,
      );
      const checkingIn = apps.checkIn().then((result) => result);
      await written;
      const saving = (
        kind === 'schedule'
          ? request(apps.base)
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
                effectiveFrom: '2026-11-09',
              })
          : request(apps.base)
              .post('/api/v1/hr/holidays/changes')
              .set('Authorization', apps.hr)
              .set('Idempotency-Key', randomUUID())
              .send({
                year: 2026,
                expectedVersion: 0,
                upsert: [
                  {
                    date: '2026-11-09',
                    name: 'Company day',
                    category: 'COMPANY',
                  },
                ],
                remove: [],
              })
      ).then((result) => result);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        (
          await apps.source.manager.findOneByOrFail(CalendarStateEntity, {
            id: 1,
          })
        ).version,
      ).toBe(0);
      await control(apps.attendance, { hold: false });
      const [checkIn, saved] = await Promise.all([checkingIn, saving]);
      expect(checkIn.status).toBe(201);
      expect(saved.status).toBe(200);
      expect((await apps.home()).body.day.attendance.schedule).toEqual(
        checkIn.body.schedule,
      );
      expect(
        (await apps.checkOut(checkIn.body.id).expect(200)).body.schedule,
      ).toEqual(checkIn.body.schedule);
    },
  );

  it('rechecks current persisted eligibility after an advisory home response', async () => {
    expect((await apps.home()).body.day.canCheckIn).toBe(true);
    await request(apps.base)
      .post('/api/v1/hr/holidays/changes')
      .set('Authorization', apps.hr)
      .set('Idempotency-Key', randomUUID())
      .send({
        year: 2026,
        expectedVersion: 0,
        upsert: [
          { date: '2026-11-09', name: 'Company day', category: 'COMPANY' },
        ],
        remove: [],
      })
      .expect(200);
    await apps
      .checkIn()
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('ATTENDANCE_NOT_REQUIRED'));
    expect(await apps.snapshotCounts()).toEqual({
      records: 0,
      receipts: 0,
      files: 1,
    });
    expect(await readdir(apps.root)).toEqual([]);
  });

  it('uses one joined attendance read for home and trusts issued claims until JWT expiry', async () => {
    const created = await apps.checkIn().expect(201);
    const before = queryCounts(apps.attendance);
    const gatewayBefore = queryCounts(apps.gateway);
    const home = await apps.home();
    expect(
      queryCounts(apps.attendance).attendanceReads - before.attendanceReads,
    ).toBe(1);
    expect(queryCounts(apps.attendance).reads - before.reads).toBe(4);
    expect(queryCounts(apps.gateway).reads - gatewayBefore.reads).toBe(0);
    expect(home.body.day.attendance.id).toBe(created.body.id);
    const issued = apps.owner;
    // A status edit is not token revocation; no role/status auth lookup is introduced.
    await apps.source.manager.update(
      EmployeeEntity,
      { id: apps.ids.employee },
      { status: 'INACTIVE' },
    );
    await apps.home(issued);
    await apps.setTime('2026-11-09T03:00:00.000Z');
    await request(apps.base)
      .get('/api/v1/me/home')
      .set('Authorization', issued)
      .expect(401)
      .expect('WWW-Authenticate', /invalid_token/);
    await apps.checkOut(created.body.id, 1, randomUUID(), issued).expect(401);
  });
});
