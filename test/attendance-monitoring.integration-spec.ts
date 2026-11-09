import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  EmployeeEntity,
  DivisionEntity,
  PositionEntity,
  HolidayCalendarEntity,
  HolidayEntity,
  ScheduleVersionEntity,
} from '../src/database/entities';
import { attendanceReadApps } from './attendance-read.fixture';
import type { AttendanceReadApps } from './attendance-read.fixture';
import { control } from './attendance-fixture';
import {
  processMessage,
  queryCounts,
  stopProcess,
} from './file-handoff.helpers';

describe('HR monitoring filters, totals and read consistency across two processes', () => {
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

  it('filters before pagination, keeps late overlapping, and searches only literal UUID/name fields', async () => {
    const { apps } = reads;
    const [alpha] = await reads.employees(['Alpha 100%_!']);
    const refs = await reads.department();
    const [beta] = await reads.employees(['Beta'], refs);
    await apps.source.manager.update(
      DivisionEntity,
      { id: refs.divisionId },
      { status: 'INACTIVE' },
    );
    await apps.source.manager.update(
      PositionEntity,
      { id: refs.positionId },
      { status: 'INACTIVE' },
    );
    const working = await apps.checkIn().expect(201);
    await apps.setTime('2026-11-09T01:00:00.000Z');
    const otherToken = await apps.token(apps.ids.otherEmployee);
    const onTime = await apps
      .checkIn(randomUUID(), apps.png, otherToken)
      .expect(201);
    await apps.setTime('2026-11-09T01:00:02.000Z');
    await apps
      .checkOut(onTime.body.id, 1, randomUUID(), otherToken)
      .expect(200);
    const first = await reads.monitor('date=2026-11-09&pageSize=1').expect(200);
    reads.capture('MonitoringPage', first.body);
    expect(first.body.pagination).toEqual({
      page: 1,
      pageSize: 1,
      totalItems: 4,
      totalPages: 4,
    });
    expect(first.body.items[0].employee.id).toBe(alpha);
    expect(first.body.summary).toEqual({
      notCheckedIn: 2,
      working: 1,
      completed: 1,
      late: 1,
      holiday: 0,
      restDay: 0,
      unconfigured: 0,
    });
    const last = await reads
      .monitor('date=2026-11-09&pageSize=1&page=4')
      .expect(200);
    const tied = [apps.ids.employee, apps.ids.otherEmployee].sort();
    expect(last.body.items[0].employee.id).toBe(tied[1]);
    const late = await reads
      .monitor('date=2026-11-09&punctuality=LATE')
      .expect(200);
    expect(late.body.pagination.totalItems).toBe(1);
    expect(late.body.items[0].day).toMatchObject({
      status: 'WORKING',
      attendance: { id: working.body.id, punctuality: 'LATE', lateSeconds: 1 },
    });
    expect(late.body.summary).toMatchObject({
      working: 1,
      late: 1,
      completed: 0,
    });
    expect(
      (
        await reads
          .monitor('date=2026-11-09&status=COMPLETED&punctuality=LATE')
          .expect(200)
      ).body.pagination.totalItems,
    ).toBe(0);
    const division = await reads
      .monitor('date=2026-11-09&divisionId=' + refs.divisionId)
      .expect(200);
    expect(division.body.items[0].employee).toMatchObject({
      id: beta,
      division: { id: refs.divisionId, name: 'Other division' },
      position: { id: refs.positionId },
    });

    for (const q of ['%', '%_!', 'Alpha 100%_!']) {
      const result = await reads
        .monitor('date=2026-11-09&q=' + encodeURIComponent(q))
        .expect(200);
      expect(
        result.body.items.map(
          (row: { employee: { id: string } }) => row.employee.id,
        ),
      ).toEqual([alpha]);
    }

    expect(
      (
        await reads
          .monitor('date=2026-11-09&q=' + apps.ids.employee)
          .expect(200)
      ).body.pagination.totalItems,
    ).toBe(1);
    expect(
      (
        await reads
          .monitor(
            'date=2026-11-09&q=' +
              encodeURIComponent(apps.ids.employee + '@example.test'),
          )
          .expect(200)
      ).body.pagination.totalItems,
    ).toBe(0);
    expect(
      (
        await reads
          .monitor('date=2026-11-09&q=' + encodeURIComponent("' OR 1=1 --"))
          .expect(200)
      ).body.pagination.totalItems,
    ).toBe(0);
    const emptyPage = await reads
      .monitor('date=2026-11-09&page=9&pageSize=1')
      .expect(200);
    expect(emptyPage.body).toMatchObject({
      items: [],
      pagination: { totalItems: 4, totalPages: 4 },
      summary: first.body.summary,
    });
  });

  it('includes inactive/pre-creation actual records while excluding inactive or not-yet-created projected accounts', async () => {
    const { apps } = reads;
    const actual = await apps.checkIn().expect(201);
    await apps.source.manager.update(
      EmployeeEntity,
      { id: apps.ids.employee },
      { status: 'INACTIVE', createdAt: new Date('2026-11-10T18:00:00.000Z') },
    );
    await apps.source.manager.update(
      EmployeeEntity,
      { id: apps.ids.otherEmployee },
      { status: 'INACTIVE' },
    );
    const [future] = await reads.employees(['Future account']);
    await apps.source.manager.update(
      EmployeeEntity,
      { id: future },
      { createdAt: new Date('2026-11-09T17:00:00.000Z') },
    );
    const result = await reads.monitor().expect(200);
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]).toMatchObject({
      employee: { id: apps.ids.employee },
      day: { attendance: { id: actual.body.id }, status: 'WORKING' },
    });
    expect(result.body.summary).toMatchObject({
      working: 1,
      notCheckedIn: 0,
      late: 1,
    });
    expect(
      (await reads.monitor('date=2026-11-10').expect(200)).body.items.map(
        (row: { employee: { id: string } }) => row.employee.id,
      ),
    ).toEqual([future]);
  });

  it('projects holidays/rest/unconfigured dates, while an actual record keeps its original state', async () => {
    const { apps } = reads;
    const actual = await apps.checkIn().expect(201);
    await apps.source.manager.update(
      ScheduleVersionEntity,
      { id: apps.ids.schedule },
      { workingDays: [2] },
    );
    const rest = await reads
      .monitor('date=2026-11-09&status=REST_DAY')
      .expect(200);
    expect(rest.body.items).toHaveLength(1);
    expect(rest.body.items[0].employee.id).toBe(apps.ids.otherEmployee);
    await apps.source.manager.insert(HolidayCalendarEntity, {
      year: 2026,
      version: 1,
    });
    await apps.source.manager.insert(HolidayEntity, {
      year: 2026,
      date: '2026-11-09',
      name: 'Holiday',
      category: 'COMPANY',
    });
    const holiday = await reads.monitor().expect(200);
    reads.capture('MonitoringPage', holiday.body);
    expect(holiday.body.summary).toMatchObject({
      working: 1,
      holiday: 1,
      late: 1,
    });
    expect(
      holiday.body.items.find(
        (row: { employee: { id: string } }) =>
          row.employee.id === apps.ids.employee,
      ).day.attendance.id,
    ).toBe(actual.body.id);
    const unconfigured = await reads
      .monitor('date=2026-10-31&status=UNCONFIGURED')
      .expect(200);
    expect(unconfigured.body.items).toHaveLength(2);
    expect(
      unconfigured.body.items.every(
        (row: { day: { schedule: unknown; attendance: unknown } }) =>
          row.day.schedule === null && row.day.attendance === null,
      ),
    ).toBe(true);
    reads.capture('MonitoringPage', unconfigured.body);
  });

  it('keeps six SELECTs at larger page sizes and selects no credentials or gateway attendance SQL', async () => {
    const { apps } = reads;
    await reads.employees(
      Array.from(
        { length: 48 },
        (_, index) => `Employee ${String(index).padStart(3, '0')}`,
      ),
    );
    const serviceBefore = queryCounts(apps.attendance);
    const gatewayBefore = queryCounts(apps.gateway);
    const one = await reads.monitor('date=2026-11-09&pageSize=1').expect(200);
    const afterOne = queryCounts(apps.attendance);
    const all = await reads.monitor('date=2026-11-09&pageSize=100').expect(200);
    const afterAll = queryCounts(apps.attendance);
    expect(one.body.pagination.totalItems).toBe(50);
    expect(all.body.items).toHaveLength(50);
    expect(all.body.summary.notCheckedIn).toBe(50);
    expect(afterOne.reads - serviceBefore.reads).toBe(6);
    expect(afterAll.reads - afterOne.reads).toBe(6);
    expect(afterAll.credentialReads - serviceBefore.credentialReads).toBe(0);
    expect(queryCounts(apps.gateway).reads - gatewayBefore.reads).toBe(0);
    expect(JSON.stringify(all.body)).not.toMatch(
      /password|email|objectKey|timeOff|approvedTimeOff/,
    );
    reads.capture('MonitoringPage', all.body);
  });

  it('keeps totals, ordering and safe employee fields in one read snapshot across a concurrent edit', async () => {
    const { apps } = reads;
    await control(apps.attendance, { holdRead: true });
    const selected = processMessage(apps.attendance, 'monitoring-selected');
    const pending = reads
      .monitor('date=2026-11-09&pageSize=1')
      .then((result) => result);
    await selected;
    const firstId = [apps.ids.employee, apps.ids.otherEmployee].sort()[0];
    await apps.source.manager.update(
      EmployeeEntity,
      { id: firstId },
      { fullName: 'ZZZ changed', status: 'INACTIVE' },
    );
    await control(apps.attendance, { holdRead: false });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      items: [{ employee: { id: firstId, fullName: 'Fixture employee' } }],
      pagination: { totalItems: 2 },
    });
    const next = await reads.monitor().expect(200);
    expect(next.body.pagination.totalItems).toBe(1);
  });

  it('validates required filters and enforces issued HR claims even after database role changes', async () => {
    const { apps } = reads;
    await reads.monitor('date=2026-11-09', apps.owner).expect(403);
    const hr = apps.hr;
    await apps.source.manager.update(
      EmployeeEntity,
      { id: apps.ids.otherEmployee },
      { role: 'EMPLOYEE', status: 'INACTIVE' },
    );
    await reads.monitor('date=2026-11-09', hr).expect(200);

    for (const query of [
      '',
      'date=2026-02-30',
      'date=2026-11-09&page=0',
      'date=2026-11-09&pageSize=101',
      'date=2026-11-09&status=TIME_OFF',
      'date=2026-11-09&punctuality=UNKNOWN',
      'date=2026-11-09&divisionId=invalid',
      'date=2026-11-09&q=' + 'x'.repeat(161),
      'date=2026-11-09&sort=passwordHash',
    ]) {
      await reads.monitor(query).expect(400);
    }
  });

  it('fails reads safely on attendance outage/deadline, restarts cleanly and keeps profile content independent', async () => {
    const { apps } = reads;
    const actual = await apps.checkIn().expect(201);
    const profile = await request(apps.base)
      .patch('/api/v1/hr/employees/' + apps.ids.employee)
      .set('Authorization', apps.hr)
      .set('Idempotency-Key', randomUUID())
      .field('expectedVersion', '1')
      .attach('photo', apps.png, {
        filename: 'profile.png',
        contentType: 'image/png',
      })
      .expect(200);
    const before = await apps.snapshotCounts();
    const monitor = await reads.monitor().expect(200);
    expect(
      monitor.body.items.find(
        (row: { employee: { id: string } }) =>
          row.employee.id === apps.ids.employee,
      ).employee.photo.id,
    ).toBe(profile.body.photo.id);
    await stopProcess(apps.attendance);

    for (const call of [
      reads.history(),
      reads.monitor(),
      reads.detail(actual.body.id),
      reads.detail(actual.body.id, true),
    ]) {
      await call
        .expect(503)
        .expect(({ body }) =>
          expect(body.code).toBe('ATTENDANCE_SERVICE_UNAVAILABLE'),
        );
    }

    await request(apps.base)
      .get(actual.body.photo.contentPath)
      .set('Authorization', apps.owner)
      .expect(503);
    const photo = await request(apps.base)
      .get(profile.body.photo.contentPath)
      .set('Authorization', apps.owner)
      .expect(200);
    expect(photo.body).toEqual(apps.png);
    await apps.restartAttendance();
    await reads.history().expect(200);
    await reads.detail(actual.body.id).expect(200);
    await control(apps.attendance, { readDelayMs: 1500 });
    await reads
      .monitor()
      .expect(503)
      .expect(({ body }) =>
        expect(body.code).toBe('ATTENDANCE_SERVICE_TIMEOUT'),
      );
    await control(apps.attendance, { readDelayMs: 0 });
    expect(await apps.snapshotCounts()).toEqual(before);
  });
});
