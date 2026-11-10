import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import {
  EmployeeEntity,
  HolidayCalendarEntity,
  HolidayEntity,
  ScheduleVersionEntity,
} from '../src/database/entities';
import { attendanceReadApps } from './attendance-read.fixture';
import type { AttendanceReadApps } from './attendance-read.fixture';
import { queryCounts } from './file-handoff.helpers';

describe('dated self history and actual-record reads across two processes', () => {
  let reads: AttendanceReadApps;

  beforeAll(async () => {
    reads = await attendanceReadApps();
  });
  beforeEach(async () => {
    await reads.reset();
  });
  afterEach(async () => {
    await reads.clean();
  });
  afterAll(async () => {
    await reads?.apps.close();
  });

  it('returns newest-first nullable projections and immutable actual evidence without inserting rows', async () => {
    const { apps } = reads;
    const first = await apps.checkIn().expect(201);
    await apps.setTime('2026-11-09T01:00:02.000Z');
    const closed = await apps.checkOut(first.body.id).expect(200);
    await apps.source.manager.update(
      ScheduleVersionEntity,
      { id: apps.ids.schedule },
      {
        workingDays: [1, 2, 3, 4, 5],
        startTime: '09:00',
        endTime: '17:00',
        timeZone: 'Asia/Singapore',
      },
    );
    await apps.source.manager.insert(HolidayCalendarEntity, {
      year: 2026,
      version: 1,
    });
    await apps.source.manager.insert(HolidayEntity, [
      {
        year: 2026,
        date: '2026-11-09',
        name: 'Changed day',
        category: 'COMPANY',
      },
      { year: 2026, date: '2026-11-10', name: 'Holiday', category: 'PUBLIC' },
    ]);
    const before = await apps.snapshotCounts();
    const page = await reads
      .history('from=2026-11-06&to=2026-11-10&pageSize=2')
      .expect(200);
    reads.capture('AttendanceDayPage', page.body);
    expect(page.body.pagination).toEqual({
      page: 1,
      pageSize: 2,
      totalItems: 5,
      totalPages: 3,
    });
    expect(
      page.body.items.map((row: { status: string }) => row.status),
    ).toEqual(['HOLIDAY', 'COMPLETED']);
    expect(page.body.items[0]).toMatchObject({
      attendance: null,
      schedule: null,
      canCheckIn: false,
    });
    expect(page.body.items[1].attendance).toEqual({
      ...closed.body,
      checkOutDeadlineAt: '2026-11-11T00:45:00.000Z',
    });
    expect(page.body.items[1].attendance).toMatchObject({
      lateSeconds: 1,
      punctuality: 'LATE',
      schedule: first.body.schedule,
    });
    const next = await reads
      .history('from=2026-11-06&to=2026-11-10&page=2&pageSize=2')
      .expect(200);
    expect(
      next.body.items.map((row: { workDate: string }) => row.workDate),
    ).toEqual(['2026-11-08', '2026-11-07']);
    expect(
      next.body.items.every(
        (row: { status: string; attendance: unknown }) =>
          row.status === 'REST_DAY' && row.attendance === null,
      ),
    ).toBe(true);
    expect(
      (
        await reads
          .history('from=2026-11-06&to=2026-11-10&page=3&pageSize=2')
          .expect(200)
      ).body.items[0],
    ).toMatchObject({
      status: 'NOT_CHECKED_IN',
      blockReason: 'CHECK_IN_WINDOW_CLOSED',
    });
    expect(await apps.snapshotCounts()).toEqual(before);
    const detail = await reads.detail(first.body.id).expect(200);
    expect(detail.body).toEqual({
      ...closed.body,
      checkOutDeadlineAt: '2026-11-11T00:45:00.000Z',
    });
    reads.capture('Attendance', detail.body);
    const photo = await request(apps.base)
      .get(detail.body.photo.contentPath)
      .set('Authorization', apps.owner)
      .expect(200);
    expect(photo.body).toEqual(apps.png);
  });

  it('projects before first schedule coverage as UNCONFIGURED and filters pre-creation dates before pagination', async () => {
    const { apps } = reads;
    const empty = await reads
      .history('from=2026-10-30&to=2026-11-02')
      .expect(200);
    expect(
      empty.body.items.map((row: { status: string }) => row.status),
    ).toEqual([
      'NOT_CHECKED_IN',
      'NOT_CHECKED_IN',
      'UNCONFIGURED',
      'UNCONFIGURED',
    ]);
    reads.capture('AttendanceDayPage', empty.body);
    const actual = await apps.checkIn().expect(201);
    await apps.source.manager.update(
      EmployeeEntity,
      { id: apps.ids.employee },
      { createdAt: new Date('2026-11-10T05:00:00.000Z'), status: 'INACTIVE' },
    );
    const visible = await reads
      .history('from=2026-11-07&to=2026-11-11&pageSize=1&page=3')
      .expect(200);
    expect(visible.body.pagination).toEqual({
      page: 3,
      pageSize: 1,
      totalItems: 3,
      totalPages: 3,
    });
    expect(visible.body.items[0]).toMatchObject({
      workDate: '2026-11-09',
      status: 'WORKING',
      attendance: { id: actual.body.id },
    });
    expect(
      (
        await reads
          .history('from=2026-11-07&to=2026-11-11&pageSize=1&page=4')
          .expect(200)
      ).body.items,
    ).toEqual([]);
  });

  it('ignores an expired record outside the range when checking the next shift', async () => {
    const { apps } = reads;
    await apps.checkIn().expect(201);
    await apps.setTime('2026-11-10T01:00:00.000Z');
    const result = await reads
      .history('from=2026-11-10&to=2026-11-10')
      .expect(200);
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]).toMatchObject({
      workDate: '2026-11-10',
      status: 'NOT_CHECKED_IN',
      attendance: null,
      canCheckIn: true,
      blockReason: null,
    });
  });

  it('authorizes self and HR details independently and returns indistinguishable missing/inaccessible 404s', async () => {
    const { apps } = reads;
    const created = await apps.checkIn().expect(201);
    await reads.detail(created.body.id).expect(200);
    await reads.detail(created.body.id, false, apps.other).expect(404);
    await reads.detail(created.body.id, false, apps.hr).expect(404);
    await reads.detail(created.body.id, true).expect(200);
    await reads.detail(created.body.id, true, apps.owner).expect(403);
    await reads.detail(randomUUID()).expect(404);
    await reads.detail(randomUUID(), true).expect(404);
    await reads.detail('malformed').expect(400);
    const client = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: {
        host: '127.0.0.1',
        port: Number(apps.env.ATTENDANCE_RPC_PORT),
      },
    });

    try {
      const envelope = {
        version: 1,
        requestId: randomUUID(),
        serviceCredential: process.env.ATTENDANCE_RPC_CREDENTIAL,
        accessToken: apps.owner.slice(7),
        input: { attendanceId: created.body.id },
      };
      await expect(
        firstValueFrom(
          client
            .send('attendance.v1.hr-record.get', envelope)
            .pipe(timeout(2000)),
        ),
      ).rejects.toMatchObject({ code: 'RPC_FORBIDDEN' });
    } finally {
      client.close();
    }
  });

  it('validates required range/pagination at HTTP and RPC, enforcing the inclusive 366-day cap before SQL', async () => {
    const { apps } = reads;
    const before = queryCounts(apps.attendance);

    for (const query of [
      '',
      'from=2026-11-09',
      'from=2026-02-30&to=2026-03-01',
      'from=2026-11-10&to=2026-11-09',
      'from=2024-01-01&to=2025-01-01',
      'from=2026-11-09&to=2026-11-09&page=1.5',
      'from=2026-11-09&to=2026-11-09&pageSize=101',
      'from=2026-11-09&to=2026-11-09&status=TIME_OFF',
    ]) {
      await reads.history(query).expect(400);
    }

    expect(queryCounts(apps.attendance).reads).toBe(before.reads);
    const client = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: {
        host: '127.0.0.1',
        port: Number(apps.env.ATTENDANCE_RPC_PORT),
      },
    });

    try {
      const envelope = {
        version: 1,
        requestId: randomUUID(),
        serviceCredential: process.env.ATTENDANCE_RPC_CREDENTIAL,
        accessToken: apps.owner.slice(7),
        input: { from: '2026-11-09', to: '2026-11-09', page: '1' },
      };
      await expect(
        firstValueFrom(
          client.send('attendance.v1.days.list', envelope).pipe(timeout(2000)),
        ),
      ).rejects.toMatchObject({ code: 'RPC_VALIDATION_FAILED' });
    } finally {
      client.close();
    }

    expect(
      (await reads.history('from=2024-01-01&to=2024-12-31').expect(200)).body
        .pagination.totalItems,
    ).toBe(0);
  });

  it('reads recorded snapshots through a later ambiguous shift definition and resolves only unrecorded items', async () => {
    const { apps } = reads;
    await apps.setTime('2026-11-01T01:00:00.000Z');
    const actual = await apps.checkIn().expect(201);
    await apps.source.manager.update(
      ScheduleVersionEntity,
      { id: apps.ids.schedule },
      { timeZone: 'America/New_York', startTime: '01:30', endTime: '09:30' },
    );
    const history = await reads
      .history('from=2026-11-01&to=2026-11-01')
      .expect(200);
    const expected = {
      ...actual.body,
      checkOutDeadlineAt: '2026-11-02T06:15:00.000Z',
    };
    expect(history.body.items[0].attendance).toEqual(expected);
    const filtered = await reads
      .monitor('date=2026-11-01&status=WORKING')
      .expect(200);
    expect(filtered.body.items[0].day.attendance).toEqual(expected);
    await reads
      .monitor('date=2026-11-01')
      .expect(422)
      .expect(({ body }) => expect(body.code).toBe('INVALID_LOCAL_TIME'));
    await apps.source.manager.insert(HolidayCalendarEntity, {
      year: 2026,
      version: 1,
    });
    await apps.source.manager.insert(HolidayEntity, {
      year: 2026,
      date: '2026-11-01',
      name: 'Holiday',
      category: 'COMPANY',
    });
    const holiday = await reads.monitor('date=2026-11-01').expect(200);
    expect(holiday.body.summary).toMatchObject({ working: 1, holiday: 1 });
    reads.capture('AttendanceDayPage', history.body);
    reads.capture('MonitoringPage', holiday.body);
  });

  it('uses four history SELECTs and one joined detail SELECT with no gateway SQL or credentials', async () => {
    const { apps } = reads;
    const created = await apps.checkIn().expect(201);
    const serviceBefore = queryCounts(apps.attendance);
    const gatewayBefore = queryCounts(apps.gateway);
    await reads
      .history('from=2026-11-01&to=2026-11-30&pageSize=100')
      .expect(200);
    const afterHistory = queryCounts(apps.attendance);
    expect(afterHistory.reads - serviceBefore.reads).toBe(4);
    await reads.detail(created.body.id).expect(200);
    const afterDetail = queryCounts(apps.attendance);
    expect(afterDetail.reads - afterHistory.reads).toBe(3);
    expect(afterDetail.credentialReads - serviceBefore.credentialReads).toBe(0);
    expect(queryCounts(apps.gateway).reads - gatewayBefore.reads).toBe(0);
  });
});
