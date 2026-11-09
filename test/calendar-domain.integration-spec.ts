import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

import { Controller, Module } from '@nestjs/common';
import type { INestMicroservice } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { DataSource, In } from 'typeorm';

import { AttendanceAppModule } from '../src/attendance-app.module';
import { AccessTokenService } from '../src/auth/access-token.service';
import { RPC_CONFIG, parseRpcConfig } from '../src/attendance-rpc/rpc.config';
import { attendanceTcpOptions } from '../src/attendance-rpc/rpc.transport';
import {
  ScheduleInput,
  TimeZonesInput,
} from '../src/attendance-rpc/rpc.inputs';
import { createRpcClient } from '../src/gateway-attendance/rpc.client';
import type { RpcClient } from '../src/gateway-attendance/rpc.client';
import {
  AttendanceEntity,
  DivisionEntity,
  PositionEntity,
  EmployeeEntity,
  FileObjectEntity,
  ScheduleVersionEntity,
  HolidayCalendarEntity,
  HolidayEntity,
} from '../src/database/entities';
import { CalendarService } from '../src/work-calendar/calendar.service';
import { WorkCalendarModule } from '../src/work-calendar/calendar.module';
import { Clock } from '../src/runtime/clock';
import type { ScheduleSnapshot } from '../src/attendance-rpc/rpc.responses';

import { insertFixture, prepareTestDatabase } from './mysql-fixture';

class CalendarClock extends Clock {
  now() {
    return new Date('2026-11-09T01:00:00.123Z');
  }
}

// Test-only patterns invoke production providers; no feature route is shipped here.
@Controller()
class CalendarProbe {
  constructor(private readonly calendar: CalendarService) {}

  @MessagePattern('calendar.test.day')
  day(@Payload('input') input: TimeZonesInput) {
    return this.calendar.readDay(input.atDate!);
  }

  @MessagePattern('calendar.test.snapshot')
  snapshot(@Payload('input') input: TimeZonesInput) {
    return this.calendar.readSnapshot(input.atDate!);
  }

  @MessagePattern('calendar.test.preview')
  preview(@Payload('input') input: ScheduleInput) {
    return this.calendar.preview(input);
  }
}

@Module({
  imports: [AttendanceAppModule, WorkCalendarModule],
  controllers: [CalendarProbe],
})
class CalendarProbeModule {}

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));

  return port;
}

describe('attendance-owned calendar domain with saved MySQL data and real TCP', () => {
  let app: INestMicroservice;
  let source: DataSource;
  let client: RpcClient;
  let token: string;
  let credential: string;
  let ids: Awaited<ReturnType<typeof insertFixture>>;
  let extraVersions: string[];
  const samples = JSON.parse(
    readFileSync(resolve(__dirname, '../../contracts/examples.json'), 'utf8'),
  ) as { name: string; value: Record<string, unknown> }[];

  const fixture = (name: string) =>
    samples.find((sample) => sample.name === name)!.value;

  beforeAll(async () => {
    const prepared = await prepareTestDatabase();
    await prepared.destroy();
    const config = parseRpcConfig({
      ATTENDANCE_RPC_CREDENTIAL:
        'calendar-domain-test-credential-at-least-32-bytes',
      ATTENDANCE_RPC_PORT: String(await freePort()),
    });
    credential = config.serviceCredential;
    const module = await Test.createTestingModule({
      imports: [CalendarProbeModule],
    })
      .overrideProvider(RPC_CONFIG)
      .useValue(config)
      .overrideProvider(Clock)
      .useClass(CalendarClock)
      .compile();
    app = module.createNestMicroservice({
      ...attendanceTcpOptions(config),
      logger: false,
    });
    await app.listen();
    source = app.get(DataSource);
    client = createRpcClient(config);
    token = (
      await app.get(AccessTokenService).issue({ id: randomUUID(), role: 'HRD' })
    ).accessToken;
  });

  beforeEach(async () => {
    ids = await source.transaction(insertFixture);
    extraVersions = [];
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await source.manager.delete(AttendanceEntity, {
      employeeId: In([ids.employee, ids.otherEmployee]),
    });
    await source.manager.delete(HolidayEntity, { year: In([2026, 2027]) });
    await source.manager.delete(HolidayCalendarEntity, {
      year: In([2026, 2027]),
    });
    await source.manager.delete(ScheduleVersionEntity, {
      id: In([ids.schedule, ...extraVersions]),
    });
    await source.manager.delete(FileObjectEntity, { id: ids.file });
    await source.manager.delete(EmployeeEntity, {
      id: In([ids.employee, ids.otherEmployee]),
    });
    await source.manager.delete(PositionEntity, { id: ids.position });
    await source.manager.delete(DivisionEntity, { id: ids.division });
  });

  afterAll(async () => {
    client?.close();
    await app?.close();
  });

  function call<T>(pattern: string, input: unknown): Promise<T> {
    return firstValueFrom(
      client
        .send<T>(pattern, {
          version: 1,
          requestId: randomUUID(),
          serviceCredential: credential,
          accessToken: token,
          input,
        })
        .pipe(timeout(2000)),
    );
  }

  it('projects an overnight year-boundary snapshot matching the validated shared contract sample', async () => {
    await source.manager.update(
      ScheduleVersionEntity,
      { id: ids.schedule },
      { startTime: '22:00', endTime: '06:00', endDayOffset: 1 },
    );
    const snapshot = await call<ScheduleSnapshot>('calendar.test.snapshot', {
      atDate: '2026-12-31',
    });

    expect(snapshot).toEqual({
      ...fixture('Calendar overnight year-boundary snapshot'),
      scheduleVersionId: ids.schedule,
    });
    expect(snapshot.workDate).toBe('2026-12-31');
  });

  it('matches the public preview activation fragment using a validated RPC input DTO', async () => {
    const sample = fixture('Calendar Makassar future activation preview');
    const result = await call('calendar.test.preview', sample.schedule);

    expect(result).toEqual({
      comparisonDate: sample.comparisonDate,
      activationMode: sample.activationMode,
      effectiveAt: sample.effectiveAt,
    });
    await expect(
      call('calendar.test.preview', {
        ...(sample.schedule as object),
        workingDays: [1, 1],
      }),
    ).rejects.toMatchObject({ code: 'RPC_VALIDATION_FAILED' });
  });

  it('selects saved versions by activation without mutating rows or opening a read transaction', async () => {
    const id = randomUUID();
    extraVersions.push(id);
    await source.manager.insert(ScheduleVersionEntity, {
      id,
      workingDays: [1, 2, 3, 4, 5],
      startTime: '09:00',
      endTime: '17:00',
      endDayOffset: 0,
      timeZone: 'Asia/Makassar',
      effectiveFrom: '2026-11-16',
      effectiveAt: new Date('2026-11-15T16:00:00Z'),
      createdBy: ids.employee,
    });
    const queries: string[] = [];
    jest.spyOn(source.logger, 'logQuery').mockImplementation((sql: string) => {
      queries.push(sql);
    });
    const before = await call<ScheduleSnapshot>('calendar.test.snapshot', {
      atDate: '2026-11-15',
    });
    const after = await call<ScheduleSnapshot>('calendar.test.snapshot', {
      atDate: '2026-11-16',
    });

    expect(before.scheduleVersionId).toBe(ids.schedule);
    expect(after).toMatchObject({
      scheduleVersionId: id,
      timeZone: 'Asia/Makassar',
      plannedStartAt: '2026-11-16T01:00:00.000Z',
    });
    expect(queries).toHaveLength(2);
    expect(queries.every((sql) => /^SELECT /i.test(sql))).toBe(true);
    const calendar = app.get(CalendarService);

    expect(
      (await calendar.readAt('2026-11-15T15:59:59.999Z')).current?.id,
    ).toBe(ids.schedule);
    expect((await calendar.readAt('2026-11-15T16:00:00Z')).current?.id).toBe(
      id,
    );
  });

  it('assigns holidays to the starting date/year with two bounded queries, not an overnight end date', async () => {
    await source.manager.update(
      ScheduleVersionEntity,
      { id: ids.schedule },
      { startTime: '22:00', endTime: '06:00', endDayOffset: 1 },
    );
    await source.manager.insert(HolidayCalendarEntity, {
      year: 2027,
      version: 1,
    });
    await source.manager.insert(HolidayEntity, {
      year: 2027,
      date: '2027-01-01',
      name: 'New Year',
      category: 'PUBLIC',
    });
    const queries: string[] = [];
    jest.spyOn(source.logger, 'logQuery').mockImplementation((sql: string) => {
      queries.push(sql);
    });
    const december = await call<{ kind: string }>('calendar.test.day', {
      atDate: '2026-12-31',
    });

    expect(december.kind).toBe('WORKING_DAY');
    expect(queries).toHaveLength(2);
    expect(queries.every((sql) => /^SELECT /i.test(sql))).toBe(true);
    queries.length = 0;
    const january = await call<{
      kind: string;
      schedule: unknown;
      holiday: { date: string };
    }>('calendar.test.day', { atDate: '2027-01-01' });

    expect(january).toMatchObject({
      kind: 'HOLIDAY',
      schedule: null,
      holiday: { date: '2027-01-01' },
    });
    expect(queries).toHaveLength(2);
  });

  it('keeps explicit manager reads inside their caller-owned transaction without caching rolled-back data', async () => {
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    try {
      await runner.manager.update(
        ScheduleVersionEntity,
        { id: ids.schedule },
        { timeZone: 'Asia/Makassar' },
      );
      const inside = await app
        .get(CalendarService)
        .readSnapshot('2026-11-09', undefined, runner.manager);
      const committed = await call<ScheduleSnapshot>('calendar.test.snapshot', {
        atDate: '2026-11-09',
      });

      expect(inside.timeZone).toBe('Asia/Makassar');
      expect(committed.timeZone).toBe('Asia/Jakarta');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }

    expect(
      (
        await call<ScheduleSnapshot>('calendar.test.snapshot', {
          atDate: '2026-11-09',
        })
      ).timeZone,
    ).toBe('Asia/Jakarta');
  });

  it('preserves a previously recorded snapshot after persisted timezone/interval replacement without a calendar query', async () => {
    const recorded = await call<ScheduleSnapshot>('calendar.test.snapshot', {
      atDate: '2026-12-31',
    });
    const attendanceId = randomUUID();
    await source.manager.insert(AttendanceEntity, {
      id: attendanceId,
      employeeId: ids.employee,
      workDate: recorded.workDate,
      scheduleVersionId: recorded.scheduleVersionId,
      timeZone: recorded.timeZone,
      plannedStartAt: new Date(recorded.plannedStartAt),
      plannedEndAt: new Date(recorded.plannedEndAt),
      checkInAt: new Date(recorded.plannedStartAt),
      punctuality: 'ON_TIME',
      photoFileId: ids.file,
    });
    await source.manager.update(
      ScheduleVersionEntity,
      { id: ids.schedule },
      { timeZone: 'Asia/Makassar', startTime: '09:00', endTime: '17:00' },
    );
    const stored = await source.manager.findOneByOrFail(AttendanceEntity, {
      id: attendanceId,
    });
    const snapshot: ScheduleSnapshot = {
      scheduleVersionId: stored.scheduleVersionId,
      workDate: stored.workDate,
      timeZone: stored.timeZone,
      plannedStartAt: stored.plannedStartAt.toISOString(),
      plannedEndAt: stored.plannedEndAt.toISOString(),
    };
    const queries = jest.spyOn(source.logger, 'logQuery');
    const preserved = await app
      .get(CalendarService)
      .readSnapshot('2026-12-31', snapshot);

    expect(preserved).toEqual(recorded);
    expect(Object.isFrozen(preserved)).toBe(true);
    expect(queries).not.toHaveBeenCalled();
  });

  it('rejects missing history and ambiguous local instants through the real RPC fault mapper', async () => {
    await expect(
      call('calendar.test.snapshot', { atDate: '2026-10-31' }),
    ).rejects.toMatchObject({ code: 'SCHEDULE_NOT_CONFIGURED', status: 409 });
    await source.manager.update(
      ScheduleVersionEntity,
      { id: ids.schedule },
      { timeZone: 'America/New_York', startTime: '01:30', endTime: '04:00' },
    );

    await expect(
      call('calendar.test.snapshot', { atDate: '2026-11-01' }),
    ).rejects.toMatchObject({ code: 'INVALID_LOCAL_TIME', status: 422 });
  });
});
