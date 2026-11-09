import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JwtService } from '@nestjs/jwt';
import { In } from 'typeorm';
import sharp from 'sharp';
import request from 'supertest';
import { AccessTokenService } from '../src/auth/access-token.service';
import { loadRuntimeConfig } from '../src/runtime/runtime.config';
import {
  AttendanceEntity,
  CalendarStateEntity,
  DivisionEntity,
  EmployeeEntity,
  FileObjectEntity,
  HolidayCalendarEntity,
  HolidayEntity,
  IdempotencyOperationEntity,
  PositionEntity,
  ScheduleVersionEntity,
} from '../src/database/entities';
import { insertFixture, prepareTestDatabase } from './mysql-fixture';
import {
  freePort,
  processMessage,
  queryCounts,
  startProcess,
  stopProcess,
} from './file-handoff.helpers';

export async function control(
  child: ChildProcess,
  values: { at?: string; hold?: boolean; dropReply?: boolean },
): Promise<void> {
  const id = randomUUID();
  const ack = processMessage<{ id: string }>(
    child,
    'controlled',
    (message) => message.id === id,
  );
  child.send({ event: 'control', id, ...values });
  await ack;
}

export interface AttendanceWritten {
  employeeId: string;
  id: string;
  fileId: string;
  checkInAt: string;
}

export async function attendanceApps() {
  const source = await prepareTestDatabase();
  const root = await mkdtemp(join(tmpdir(), 'wfh-attendance-'));
  const [httpPort, rpcPort] = await Promise.all([freePort(), freePort()]);
  const env = {
    PORT: String(httpPort),
    STORAGE_ROOT: root,
    ATTENDANCE_RPC_PORT: String(rpcPort),
    ATTENDANCE_RPC_DEADLINE_MS: '1000',
  };
  const startAttendance = () =>
    startProcess('attendance', env, 'test/attendance.process.ts');
  let attendance = await startAttendance();
  const gateway = await startProcess(
    'gateway',
    env,
    'test/attendance.process.ts',
  );
  const base = `http://127.0.0.1:${httpPort}`;
  const png = await sharp({
    create: { width: 4, height: 4, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  const differentPng = await sharp({
    create: { width: 4, height: 4, channels: 3, background: 'blue' },
  })
    .png()
    .toBuffer();
  let now = new Date('2026-11-09T01:00:00.001Z');
  const tokens = new AccessTokenService(
    new JwtService(),
    { now: () => new Date(now) },
    loadRuntimeConfig(),
  );
  const captures: { schema: string; body: unknown }[] = [];
  let ids: Awaited<ReturnType<typeof insertFixture>>;
  let owner: string;
  let other: string;
  let hr: string;

  async function token(
    id = ids.employee,
    role: 'EMPLOYEE' | 'HRD' = 'EMPLOYEE',
  ): Promise<string> {
    return 'Bearer ' + (await tokens.issue({ id, role })).accessToken;
  }

  async function setTime(at: string): Promise<void> {
    now = new Date(at);
    await Promise.all([control(gateway, { at }), control(attendance, { at })]);

    if (ids) {
      [owner, other, hr] = await Promise.all([
        token(),
        token(ids.otherEmployee),
        token(ids.otherEmployee, 'HRD'),
      ]);
    }
  }

  async function reset(): Promise<void> {
    if (attendance.exitCode !== null || attendance.signalCode !== null) {
      attendance = await startAttendance();
    }

    await setTime('2026-11-09T01:00:00.001Z');
    ids = await source.transaction(insertFixture);
    [owner, other, hr] = await Promise.all([
      tokens.issue({ id: ids.employee, role: 'EMPLOYEE' }),
      tokens.issue({ id: ids.otherEmployee, role: 'EMPLOYEE' }),
      tokens.issue({ id: ids.otherEmployee, role: 'HRD' }),
    ]).then((grants) => grants.map((grant) => 'Bearer ' + grant.accessToken));
  }

  async function clean(): Promise<void> {
    await control(attendance, { hold: false });
    await stopProcess(attendance);
    const employees = In([ids.employee, ids.otherEmployee]);
    await source.manager.delete(IdempotencyOperationEntity, {
      actorId: employees,
    });
    await source.manager.delete(AttendanceEntity, { employeeId: employees });
    await source.manager.update(
      EmployeeEntity,
      { id: employees },
      { photoFileId: null },
    );
    await source.manager.delete(FileObjectEntity, {
      ownerEmployeeId: employees,
    });
    await source.manager.delete(HolidayEntity, { year: In([2026, 2027]) });
    await source.manager.delete(HolidayCalendarEntity, {
      year: In([2026, 2027]),
    });
    // Test-only reset: the append-only history trigger correctly rejects DELETE.
    await source.query('TRUNCATE TABLE schedule_events');
    await source.manager.delete(ScheduleVersionEntity, {
      createdBy: employees,
    });
    await source.manager.delete(EmployeeEntity, { id: employees });
    await source.manager.delete(PositionEntity, { id: ids.position });
    await source.manager.delete(DivisionEntity, { id: ids.division });
    await source.manager.update(CalendarStateEntity, { id: 1 }, { version: 0 });
    await Promise.all(
      (await readdir(root)).map((name) => unlink(join(root, name))),
    );
  }

  function checkIn(key: string = randomUUID(), bytes = png, token = owner) {
    return request(base)
      .post('/api/v1/me/attendances/check-in')
      .set('Authorization', token)
      .set('Idempotency-Key', key)
      .attach('photo', bytes, {
        filename: 'photo.png',
        contentType: 'image/png',
      });
  }

  function checkOut(
    id: string,
    expectedVersion = 1,
    key: string = randomUUID(),
    token = owner,
  ) {
    return request(base)
      .post(`/api/v1/me/attendances/${id}/check-out`)
      .set('Authorization', token)
      .set('Idempotency-Key', key)
      .send({ expectedVersion });
  }

  async function home(token = owner) {
    const result = await request(base)
      .get('/api/v1/me/home')
      .set('Authorization', token)
      .expect(200);
    captures.push({ schema: 'Home', body: result.body });

    return result;
  }

  async function snapshotCounts(): Promise<{
    records: number;
    receipts: number;
    files: number;
  }> {
    const [records, receipts, files] = await Promise.all([
      source.manager.countBy(AttendanceEntity, { employeeId: ids.employee }),
      source.manager.countBy(IdempotencyOperationEntity, {
        actorId: ids.employee,
      }),
      source.manager.countBy(FileObjectEntity, {
        ownerEmployeeId: ids.employee,
      }),
    ]);

    return { records, receipts, files };
  }

  async function close(): Promise<void> {
    expect(queryCounts(gateway).attendanceReads).toBe(0);
    await Promise.all([stopProcess(attendance), stopProcess(gateway)]);
    await source.destroy();
    await rm(root, { recursive: true, force: true });

    if (process.env.CONTRACT_CAPTURE_PATH) {
      await writeFile(
        process.env.CONTRACT_CAPTURE_PATH + '-' + httpPort + '.json',
        JSON.stringify(captures),
        { mode: 0o600 },
      );
    }
  }

  return {
    source,
    gateway,
    base,
    root,
    png,
    differentPng,
    env,
    captures,
    reset,
    clean,
    close,
    home,
    checkIn,
    checkOut,
    setTime,
    snapshotCounts,
    token,
    get attendance() {
      return attendance;
    },
    get ids() {
      return ids;
    },
    get owner() {
      return owner;
    },
    get other() {
      return other;
    },
    get hr() {
      return hr;
    },
  };
}

export type AttendanceApps = Awaited<ReturnType<typeof attendanceApps>>;
