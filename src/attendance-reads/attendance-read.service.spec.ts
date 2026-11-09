import { AttendanceReadService } from './attendance-read.service';
import type { AttendanceReadRepository } from './attendance-read.repository';
import type { MonitoringRepository } from './monitoring.repository';
import type { CalendarRepository } from '../work-calendar/calendar.repository';
import { AttendanceEntity, EmployeeEntity } from '../database/entities';
import type { EntityManager } from 'typeorm';

const at = new Date('2026-11-09T01:00:00.000Z');
const manager = {} as EntityManager;
const version = {
  id: 'schedule',
  workingDays: [1, 2, 3, 4, 5, 6, 7],
  startTime: '08:00',
  endTime: '16:00',
  endDayOffset: 0,
  timeZone: 'Asia/Jakarta',
  effectiveFrom: '2026-11-01',
  effectiveAt: '2026-10-31T17:00:00.000Z',
  supersededAt: null,
};

function record(date = '2026-11-09', employeeId = 'employee', closed = false) {
  return Object.assign(new AttendanceEntity(), {
    id: 'record-' + employeeId,
    employeeId,
    workDate: date,
    scheduleVersionId: 'original',
    timeZone: 'Asia/Jakarta',
    plannedStartAt: new Date(date + 'T01:00:00.000Z'),
    plannedEndAt: new Date(date + 'T09:00:00.000Z'),
    checkInAt: new Date(date + 'T01:00:00.001Z'),
    checkOutAt: closed ? new Date(date + 'T02:00:00.000Z') : null,
    punctuality: 'LATE',
    lateSeconds: 1,
    durationSeconds: closed ? 3599 : null,
    version: closed ? 2 : 1,
    photo: {
      id: 'photo',
      purpose: 'CHECK_IN_PHOTO',
      mimeType: 'image/png',
      fileName: 'photo.png',
      sizeBytes: 123,
    },
    photoFileId: 'photo',
  });
}

function employee(id: string, name = id) {
  return Object.assign(new EmployeeEntity(), {
    id,
    fullName: name,
    division: { id: 'division', code: 'D', name: 'Division' },
    position: { id: 'position', code: 'P', name: 'Position' },
    photo: null,
  });
}

function setup() {
  const repository = {
    consistent: jest.fn(async (work) => work(manager)),
    employee: jest
      .fn()
      .mockResolvedValue({
        id: 'employee',
        createdAt: new Date('2026-11-09T05:00:00.000Z'),
      }),
    holidays: jest.fn().mockResolvedValue([]),
    history: jest.fn().mockResolvedValue([]),
    detail: jest.fn().mockResolvedValue(null),
    selectedRecords: jest.fn().mockResolvedValue([]),
  };
  const monitoring = {
    selected: jest.fn().mockResolvedValue({ ids: [], totals: [] }),
    employees: jest.fn().mockResolvedValue([]),
  };
  const calendar = { timeline: jest.fn().mockResolvedValue([version]) };
  const service = new AttendanceReadService(
    repository as unknown as AttendanceReadRepository,
    monitoring as unknown as MonitoringRepository,
    calendar as unknown as CalendarRepository,
    { now: () => new Date(at) },
  );

  return { service, repository, monitoring, calendar };
}

describe('AttendanceReadService', () => {
  it('excludes projected pre-creation dates before pagination but retains imported actual attendance', async () => {
    const { service, repository } = setup();
    repository.history.mockResolvedValue([
      record('2026-11-07', 'employee', true),
    ]);
    const result = await service.history('employee', {
      from: '2026-11-07',
      to: '2026-11-10',
      page: 2,
      pageSize: 1,
    });
    expect(result.pagination).toEqual({
      page: 2,
      pageSize: 1,
      totalItems: 3,
      totalPages: 3,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      workDate: '2026-11-09',
      status: 'NOT_CHECKED_IN',
      attendance: null,
    });
    const older = await service.history('employee', {
      from: '2026-11-07',
      to: '2026-11-10',
      page: 3,
      pageSize: 1,
    });
    expect(older.items[0]).toMatchObject({
      workDate: '2026-11-07',
      status: 'COMPLETED',
      attendance: { schedule: { scheduleVersionId: 'original' } },
    });
  });

  it('blocks projected check-in when the employee has an open record outside the requested range', async () => {
    const { service, repository } = setup();
    repository.history.mockResolvedValue([record('2026-11-01')]);
    const result = await service.history('employee', {
      from: '2026-11-09',
      to: '2026-11-09',
    });
    expect(result.items[0]).toMatchObject({
      canCheckIn: false,
      canCheckOut: false,
      blockReason: 'ALREADY_CHECKED_IN',
    });
  });

  it('preserves recorded snapshots and states despite later holiday/schedule changes', async () => {
    const { service, repository, calendar } = setup();
    repository.history.mockResolvedValue([record()]);
    repository.holidays.mockResolvedValue([{ date: '2026-11-09' }]);
    calendar.timeline.mockResolvedValue([]);
    const result = await service.history('employee', {
      from: '2026-11-09',
      to: '2026-11-09',
    });
    expect(result.items[0]).toMatchObject({
      status: 'WORKING',
      canCheckOut: true,
      schedule: { scheduleVersionId: 'original', timeZone: 'Asia/Jakarta' },
    });
  });

  it('returns empty high pages with correct totals and does not write synthetic attendance', async () => {
    const { service } = setup();
    const result = await service.history('employee', {
      from: '2026-11-09',
      to: '2026-11-10',
      page: 99,
      pageSize: 1,
    });
    expect(result).toEqual({
      items: [],
      pagination: { page: 99, pageSize: 1, totalItems: 2, totalPages: 2 },
    });
  });

  it('rejects oversized ranges before opening a database transaction', async () => {
    const { service, repository } = setup();
    await expect(
      service.history('employee', { from: '2024-01-01', to: '2025-01-01' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repository.consistent).not.toHaveBeenCalled();
  });

  it('returns a safe 404 for a missing employee or inaccessible actual record', async () => {
    const { service, repository } = setup();
    repository.employee.mockResolvedValue(null);
    await expect(
      service.history('employee', { from: '2026-11-09', to: '2026-11-09' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.detail('other-record', 'employee'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(repository.detail).toHaveBeenCalledWith('other-record', 'employee');
  });

  it('returns an actual record independently of today’s schedule without private paths', async () => {
    const { service, repository, calendar } = setup();
    repository.detail.mockResolvedValue(record());
    const result = await service.detail('record-employee', 'employee');
    expect(result.photo.contentPath).toBe('/api/v1/files/photo');
    expect(result).not.toHaveProperty('objectKey');
    expect(calendar.timeline).not.toHaveBeenCalled();
  });

  it('preserves SQL page ordering, uses pre-pagination totals and maps actual versus unrecorded rows', async () => {
    const { service, repository, monitoring } = setup();
    monitoring.selected.mockResolvedValue({
      ids: ['b', 'a'],
      totals: [
        { status: 'WORKING', total: '3', late: '2' },
        { status: 'NOT_CHECKED_IN', total: '20', late: '0' },
      ],
    });
    monitoring.employees.mockResolvedValue([employee('a'), employee('b')]);
    repository.selectedRecords.mockResolvedValue([
      record('2026-11-09', 'a'),
      record('2026-11-08', 'b'),
    ]);
    const result = await service.monitor({
      date: '2026-11-09',
      page: 2,
      pageSize: 2,
    });
    expect(result.items.map((row) => row.employee.id)).toEqual(['b', 'a']);
    expect(result.items[0].day).toMatchObject({
      status: 'NOT_CHECKED_IN',
      canCheckIn: false,
      blockReason: 'ALREADY_CHECKED_IN',
    });
    expect(result.items[1].day).toMatchObject({
      status: 'WORKING',
      canCheckOut: true,
    });
    expect(result.pagination).toEqual({
      page: 2,
      pageSize: 2,
      totalItems: 23,
      totalPages: 12,
    });
    expect(result.summary).toMatchObject({
      working: 3,
      notCheckedIn: 20,
      late: 2,
    });
  });

  it('preserves filtered totals on an empty page', async () => {
    const { service, monitoring } = setup();
    monitoring.selected.mockResolvedValue({
      ids: [],
      totals: [{ status: 'COMPLETED', total: 2, late: 1 }],
    });
    const result = await service.monitor({
      date: '2026-11-09',
      page: 9,
      pageSize: 1,
    });
    expect(result).toMatchObject({
      items: [],
      pagination: { totalItems: 2, totalPages: 2 },
      summary: { completed: 2, late: 1 },
    });
  });
});
