import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { AttendanceService } from './attendance.service';
import type { AttendanceRepository } from './attendance.repository';
import type { ScheduleRepository } from '../work-schedule/schedule.repository';
import type { AttendanceFileService } from '../attendance-files/attendance-file.service';
import type { StagedCheckInImage } from '../attendance-rpc/rpc.files';
import { AttendanceEntity, ScheduleVersionEntity } from '../database/entities';
import { attendanceView } from './attendance.mapper';

const employeeId = randomUUID();
const at = new Date('2026-11-09T01:00:00.001Z');
const manager = {} as EntityManager;
const photo = {
  id: randomUUID(),
  fileName: 'photo.png',
  mimeType: 'image/png',
  sizeBytes: 10,
  purpose: 'CHECK_IN_PHOTO' as const,
};
const image = {
  ...photo,
  sha256: 'a'.repeat(64),
  ownerEmployeeId: employeeId,
  objectKey: photo.id + '.png',
  stagedAt: at.toISOString(),
} as StagedCheckInImage;
const schedule = Object.assign(new ScheduleVersionEntity(), {
  id: randomUUID(),
  workingDays: [1, 2, 3, 4, 5],
  startTime: '08:00',
  endTime: '16:00',
  endDayOffset: 0,
  timeZone: 'Asia/Jakarta',
  effectiveFrom: '2026-11-01',
  effectiveAt: new Date('2026-10-31T17:00:00.000Z'),
  supersededAt: null,
  actor: { id: employeeId, fullName: 'Employee' },
  createdAt: at,
});

function record(checkOutAt: Date | null = null) {
  return Object.assign(new AttendanceEntity(), {
    id: randomUUID(),
    employeeId,
    workDate: '2026-11-08',
    scheduleVersionId: schedule.id,
    timeZone: 'Asia/Jakarta',
    plannedStartAt: new Date('2026-11-08T15:00:00.000Z'),
    plannedEndAt: new Date('2026-11-08T23:00:00.000Z'),
    checkInAt: new Date('2026-11-08T15:00:00.001Z'),
    checkOutAt,
    punctuality: 'LATE',
    lateSeconds: 1,
    durationSeconds: null,
    photoFileId: photo.id,
    photo,
    version: 1,
  });
}

function setup() {
  const repository = {
    readConsistent: jest.fn(async (work) => work(manager)),
    calendar: jest.fn().mockResolvedValue({ version: 1 }),
    lockEmployee: jest.fn().mockResolvedValue(undefined),
    records: jest.fn().mockResolvedValue([]),
    holidays: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockResolvedValue(undefined),
    markMissed: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(),
  };
  const schedules = { versions: jest.fn().mockResolvedValue([schedule]) };
  const files = { attach: jest.fn().mockResolvedValue(undefined) };
  const clock = { now: jest.fn().mockReturnValue(at) };
  const service = new AttendanceService(
    repository as unknown as AttendanceRepository,
    schedules as unknown as ScheduleRepository,
    files as unknown as AttendanceFileService,
    clock,
  );

  return { service, repository, schedules, files, clock };
}

describe('AttendanceService', () => {
  it('returns authoritative home and a window without creating a row or metadata', async () => {
    const { service, repository, files } = setup();
    const home = await service.home(employeeId);
    expect(home).toMatchObject({
      serverNow: at.toISOString(),
      companyDate: '2026-11-09',
      timeZone: 'Asia/Jakarta',
      day: { status: 'NOT_CHECKED_IN', canCheckIn: true },
      checkInWindow: {
        opensAt: '2026-11-09T00:45:00.000Z',
        closesAt: '2026-11-09T09:00:00.000Z',
      },
    });
    expect(repository.insert).not.toHaveBeenCalled();
    expect(files.attach).not.toHaveBeenCalled();
  });

  it('allows a new shift after a missed check-out without inventing an end timestamp', async () => {
    const { service, repository } = setup();
    const expired = record();
    repository.records.mockResolvedValue([expired]);
    expect((await service.home(employeeId)).day).toMatchObject({
      canCheckIn: true,
      canCheckOut: false,
      workDate: '2026-11-09',
    });
    const result = await service.checkIn(employeeId, image, at, manager);
    expect(result.workDate).toBe('2026-11-09');
    expect(repository.markMissed).toHaveBeenCalledWith(
      employeeId,
      [expired.id],
      manager,
    );
    expect(repository.markMissed.mock.invocationCallOrder[0]).toBeLessThan(
      repository.insert.mock.invocationCallOrder[0],
    );
    expect(expired.checkOutAt).toBeNull();
    expect(expired.durationSeconds).toBeNull();
  });

  it('rejects old checkout at the next opening while allowing the new shift', async () => {
    const { service, repository, clock } = setup();
    const row = record();
    repository.records.mockResolvedValue([row]);
    repository.get.mockResolvedValue(row);
    clock.now.mockReturnValue(at);
    expect((await service.home(employeeId)).day).toMatchObject({
      canCheckIn: true,
      canCheckOut: false,
      workDate: '2026-11-09',
    });
    await expect(
      service.checkOut(employeeId, row.id, 1, at, manager),
    ).rejects.toMatchObject({ code: 'MISSED_CHECK_OUT' });
    expect(repository.close).not.toHaveBeenCalled();
  });

  it.each([
    ['2026-11-08T22:00:00.000Z', 'EARLY'],
    ['2026-11-08T23:00:00.000Z', 'ON_TIME'],
    ['2026-11-09T00:00:00.000Z', 'LATE'],
    ['2026-11-09T00:44:59.999Z', 'LATE'],
  ])(
    'allows checkout at %s and classifies it as %s against the original snapshot',
    async (time, state) => {
      const { service, repository } = setup();
      const row = record();
      repository.get.mockResolvedValue(row);
      expect(
        await service.checkOut(employeeId, row.id, 1, new Date(time), manager),
      ).toMatchObject({
        state: 'COMPLETED',
        workDate: row.workDate,
        checkOutPunctuality: state,
        checkOutAt: time,
      });
    },
  );

  it('keeps an overdue holiday/weekend shift open and refuses a new check-in until its next window', async () => {
    const { service, repository, clock } = setup();
    const row = record();
    repository.records.mockResolvedValue([row]);
    repository.holidays.mockResolvedValue([{ date: '2026-11-09' }]);
    clock.now.mockReturnValue(at);
    expect((await service.home(employeeId)).day).toMatchObject({
      status: 'WORKING',
      canCheckOut: true,
      canCheckIn: false,
      attendance: {
        id: row.id,
        checkOutDeadlineAt: '2026-11-10T00:45:00.000Z',
      },
    });
    await expect(
      service.checkIn(employeeId, image, at, manager),
    ).rejects.toMatchObject({ code: 'ALREADY_CHECKED_IN' });
  });

  it('applies the saved early allowance to home and check-in', async () => {
    const { service, schedules, clock } = setup();
    schedules.versions.mockResolvedValue([
      Object.assign(new ScheduleVersionEntity(), schedule, {
        opensMinutesBeforeStart: 30,
      }),
    ]);
    const early = new Date('2026-11-09T00:30:00.000Z');
    clock.now.mockReturnValue(early);
    expect(await service.home(employeeId)).toMatchObject({
      day: { canCheckIn: true },
      workSchedule: { checkInPolicy: { opensMinutesBeforeStart: 30 } },
      checkInWindow: { opensAt: early.toISOString() },
    });
    expect(
      await service.checkIn(employeeId, image, early, manager),
    ).toMatchObject({
      punctuality: 'ON_TIME',
      schedule: { opensMinutesBeforeStart: 30 },
    });
  });

  it('returns unconfigured home with UTC date while no schedule or recorded context exists', async () => {
    const { service, schedules } = setup();
    schedules.versions.mockResolvedValue([]);
    expect(await service.home(employeeId)).toMatchObject({
      timeZone: 'UTC',
      day: { status: 'UNCONFIGURED', canCheckIn: false },
      checkInWindow: null,
      workSchedule: { current: null },
    });
  });

  it('prioritizes an old open snapshot even after a timezone/holiday change', async () => {
    const { service, repository } = setup();
    const open = Object.assign(record(), {
      plannedEndAt: new Date('2026-11-09T02:00:00.000Z'),
    });
    repository.records.mockResolvedValue([open]);
    repository.holidays.mockResolvedValue([{ date: '2026-11-09' }]);
    const home = await service.home(employeeId);
    expect(home.day).toMatchObject({
      workDate: open.workDate,
      status: 'WORKING',
      canCheckOut: true,
      canCheckIn: false,
      schedule: { plannedEndAt: open.plannedEndAt.toISOString() },
    });
    expect(home.day.attendance).toEqual(
      attendanceView(open, open.photo, at, '2026-11-10T00:45:00.000Z'),
    );
  });

  it('prioritizes an open snapshot even when today has an invalid local shift time', async () => {
    const { service, repository, schedules, clock } = setup();
    clock.now.mockReturnValue(new Date('2026-03-08T07:00:00.000Z'));
    schedules.versions.mockResolvedValue([
      Object.assign(new ScheduleVersionEntity(), schedule, {
        effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
        timeZone: 'America/New_York',
        startTime: '02:30',
        endTime: '10:30',
        workingDays: [1, 2, 3, 4, 5, 6, 7],
      }),
    ]);
    const open = Object.assign(record(), {
      workDate: '2026-03-07',
      plannedStartAt: new Date('2026-03-07T15:00:00.000Z'),
      plannedEndAt: new Date('2026-03-08T08:00:00.000Z'),
      checkInAt: new Date('2026-03-07T15:00:00.000Z'),
    });
    repository.records.mockResolvedValue([open]);
    expect((await service.home(employeeId)).day).toMatchObject({
      status: 'WORKING',
      canCheckOut: true,
      attendance: { id: open.id, schedule: { timeZone: 'Asia/Jakarta' } },
    });
  });

  it('binds file, immutable schedule and unrounded receipt inside the supplied owning transaction', async () => {
    const { service, files, repository } = setup();
    const result = await service.checkIn(employeeId, image, at, manager);
    expect(result).toMatchObject({
      employeeId,
      workDate: '2026-11-09',
      state: 'WORKING',
      checkInAt: at.toISOString(),
      checkOutAt: null,
      punctuality: 'LATE',
      lateSeconds: 1,
      durationSeconds: null,
      photo: { id: photo.id, contentPath: `/api/v1/files/${photo.id}` },
      version: 1,
    });
    expect(result.photo).not.toHaveProperty('objectKey');
    expect(files.attach).toHaveBeenCalledWith(manager, image);
    expect(repository.insert.mock.calls[0][1]).toBe(manager);
  });

  it.each(['open', 'duplicate', 'holiday', 'closed-window'])(
    'rejects %s before attaching metadata or inserting attendance',
    async (condition) => {
      const { service, repository, files } = setup();
      let receivedAt = at;

      if (condition === 'open') {
        repository.records.mockResolvedValue([
          Object.assign(record(), { workDate: '2026-11-09' }),
        ]);
      }

      if (condition === 'duplicate') {
        repository.records.mockResolvedValue([
          Object.assign(record(at), { workDate: '2026-11-09' }),
        ]);
      }

      if (condition === 'holiday') {
        repository.holidays.mockResolvedValue([{ date: '2026-11-09' }]);
      }

      if (condition === 'closed-window') {
        receivedAt = new Date('2026-11-09T09:00:00.000Z');
      }

      await expect(
        service.checkIn(employeeId, image, receivedAt, manager),
      ).rejects.toThrow();
      expect(files.attach).not.toHaveBeenCalled();
      expect(repository.insert).not.toHaveBeenCalled();
    },
  );

  it('uses upload time after slow processing/lock waits rather than the current clock', async () => {
    const { service, clock } = setup();
    clock.now.mockReturnValue(new Date('2026-11-09T10:00:00.000Z'));
    expect(await service.checkIn(employeeId, image, at, manager)).toMatchObject(
      { checkInAt: at.toISOString(), lateSeconds: 1 },
    );
  });

  it('closes the original snapshot and increments its version while revalidating the next-shift boundary', async () => {
    const { service, repository, schedules } = setup();
    const row = record();
    const originalSnapshot = attendanceView(row).schedule;
    repository.get.mockResolvedValue(row);
    const end = new Date(row.checkInAt.getTime() + 1999);
    const result = await service.checkOut(employeeId, row.id, 1, end, manager);
    expect(result).toMatchObject({
      state: 'COMPLETED',
      schedule: originalSnapshot,
      durationSeconds: 1,
      checkOutAt: end.toISOString(),
      version: 2,
    });
    expect(schedules.versions).toHaveBeenCalledWith(manager);
    expect(repository.close).toHaveBeenCalledWith(
      row.id,
      { checkOutAt: end, durationSeconds: 1, version: 2 },
      manager,
    );
  });

  it('does not update a stale checkout', async () => {
    const { service, repository } = setup();
    const row = record();
    repository.get.mockResolvedValue(row);
    await expect(
      service.checkOut(employeeId, row.id, 0, at, manager),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(repository.close).not.toHaveBeenCalled();
  });
});
