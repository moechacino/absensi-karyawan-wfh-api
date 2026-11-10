import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { Attendance, Home } from '../attendance-rpc/rpc.responses';
import type { StagedCheckInImage } from '../attendance-rpc/rpc.files';
import { AttendanceEntity } from '../database/entities';
import { AttendanceFileService } from '../attendance-files/attendance-file.service';
import { ScheduleRepository } from '../work-schedule/schedule.repository';
import { savedSchedule, scheduleView } from '../work-schedule/schedule.mapper';
import { timelineAt } from '../work-calendar/schedule.timeline';
import { dateAt } from '../work-calendar/calendar-time';
import { Clock } from '../runtime/clock';
import { AttendanceRepository } from './attendance.repository';
import { checkoutDeadline, checkoutDeadlines } from './checkout.rules';
import { attendanceView, attendanceSnapshot } from './attendance.mapper';
import {
  isOpenShift,
  candidates,
  candidateDates,
  checkInWindow,
  checkoutChanges,
  dayProjection,
  punctuality,
  requireCheckIn,
  selectDay,
} from './attendance.rules';

@Injectable()
export class AttendanceService {
  constructor(
    private readonly repository: AttendanceRepository,
    private readonly schedules: ScheduleRepository,
    private readonly files: AttendanceFileService,
    private readonly clock: Clock,
  ) {}

  home(employeeId: string): Promise<Home> {
    const at = this.clock.now();

    return this.repository.readConsistent((manager) =>
      this.context(employeeId, at, manager).then((context) => context.home),
    );
  }

  private async context(
    employeeId: string,
    at: Date,
    manager: EntityManager,
    lockedVersion?: number,
  ): Promise<{
    home: Home;
    expiredIds: string[];
    nextDeadline: string | null;
  }> {
    const [state, rows] = await Promise.all([
      lockedVersion === undefined
        ? this.repository.calendar(manager)
        : Promise.resolve({ version: lockedVersion }),
      this.schedules.versions(manager),
    ]);
    const versions = rows.map(savedSchedule);
    const current = timelineAt(versions, at).current;
    const zone = current?.timeZone ?? 'UTC';
    const dates = [
      ...new Set([dateAt(at, zone), ...candidateDates(versions, at)]),
    ];
    const records = await this.repository.records(employeeId, dates, manager);
    const from = [
      ...dates,
      ...records.map((row) => row.workDate),
    ].toSorted()[0];
    const holidays = await this.repository.holidays(from, manager);
    const holidayDates = holidays.map((row) => row.date);
    const deadlines = checkoutDeadlines(records, versions, holidayDates);
    const open = records.find((row) =>
      isOpenShift(row, at, deadlines.get(row.id)),
    );
    const expiredIds = records
      .filter(
        (row) =>
          !row.checkOutAt &&
          !row.missedCheckOut &&
          !isOpenShift(row, at, deadlines.get(row.id)),
      )
      .map((row) => row.id);
    const choices = open
      ? []
      : candidates(versions, at, holidayDates, records.map(attendanceSnapshot));
    const timeZone = current?.timeZone ?? open?.timeZone ?? 'UTC';
    const companyDate = dateAt(at, timeZone);
    const choice = selectDay(choices, companyDate, at);
    const workDate = choice?.workDate ?? companyDate;
    const record = open ?? records.find((row) => row.workDate === workDate);
    const day = dayProjection(
      workDate,
      choice,
      holidayDates.includes(workDate),
      at,
      record
        ? attendanceView(record, record.photo, at, deadlines.get(record.id))
        : null,
    );

    return {
      expiredIds,
      nextDeadline: day.schedule
        ? checkoutDeadline(versions, day.schedule.workDate, holidayDates)
        : null,
      home: {
        serverNow: at.toISOString(),
        companyDate,
        timeZone,
        day,
        workSchedule: scheduleView(state.version, rows, at),
        checkInWindow: day.schedule ? checkInWindow(day.schedule) : null,
      },
    };
  }

  async checkIn(
    employeeId: string,
    image: StagedCheckInImage,
    receivedAt: Date,
    manager: EntityManager,
  ): Promise<Attendance> {
    // Share the calendar lock with other check-ins; calendar saves take its write lock.
    // Employee locking serializes that employee's distinct keys and checkout.
    const state = await this.repository.calendar(manager, true);
    await this.repository.lockEmployee(employeeId, manager);
    const { home, expiredIds, nextDeadline } = await this.context(
      employeeId,
      receivedAt,
      manager,
      state.version,
    );
    const snapshot = requireCheckIn(home);
    const row = Object.assign(new AttendanceEntity(), {
      id: randomUUID(),
      employeeId,
      workDate: snapshot.workDate,
      opensMinutesBeforeStart: snapshot.opensMinutesBeforeStart ?? 15,
      missedCheckOut: false,
      scheduleVersionId: snapshot.scheduleVersionId,
      timeZone: snapshot.timeZone,
      plannedStartAt: new Date(snapshot.plannedStartAt),
      plannedEndAt: new Date(snapshot.plannedEndAt),
      checkInAt: receivedAt,
      checkOutAt: null,
      ...punctuality(receivedAt, snapshot.plannedStartAt),
      durationSeconds: null,
      photoFileId: image.id,
      version: 1,
    });
    await this.repository.markMissed(employeeId, expiredIds, manager);
    await this.files.attach(manager, image);
    await this.repository.insert(row, manager);

    return attendanceView(row, image, receivedAt, nextDeadline);
  }

  async checkOut(
    employeeId: string,
    id: string,
    expectedVersion: number,
    at: Date,
    manager: EntityManager,
  ): Promise<Attendance> {
    await this.repository.calendar(manager, true);
    await this.repository.lockEmployee(employeeId, manager);
    const record = await this.repository.get(id, manager);
    const [rows, holidays] = await Promise.all([
      this.schedules.versions(manager),
      this.repository.holidays(record.workDate, manager),
    ]);
    const deadline = checkoutDeadline(
      rows.map(savedSchedule),
      record.workDate,
      holidays.map((row) => row.date),
    );
    const changes = checkoutChanges(record, expectedVersion, at, deadline);
    await this.repository.close(id, changes, manager);

    return attendanceView(
      Object.assign(record, changes),
      record.photo,
      at,
      deadline,
    );
  }
}
