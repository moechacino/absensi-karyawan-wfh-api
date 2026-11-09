import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { ScheduleSnapshot } from '../attendance-rpc/rpc.responses';
import { Clock } from '../runtime/clock';

import { CalendarRepository } from './calendar.repository';
import { isoInstant, plainDate } from './calendar-time';
import type { CalendarInstant } from './calendar-time';
import type {
  CalendarDay,
  SavedSchedule,
  ScheduleProposal,
} from './calendar.types';
import {
  recordedSnapshot,
  scheduleActivation,
  snapshotForDate,
} from './schedule.rules';
import {
  holidayCutoff,
  planScheduleSave,
  scheduleForDate,
  scheduleSnapshot,
  timelineAt,
} from './schedule.timeline';

@Injectable()
export class CalendarService {
  constructor(
    private readonly repository: CalendarRepository,
    private readonly clock: Clock,
  ) {}

  preview(input: ScheduleProposal, at: CalendarInstant = this.clock.now()) {
    return scheduleActivation(input, at);
  }

  planSave(
    input: ScheduleProposal,
    versions: readonly SavedSchedule[],
    at: CalendarInstant = this.clock.now(),
  ) {
    return planScheduleSave(input, versions, at);
  }

  holidayCutoff(
    versions: readonly SavedSchedule[],
    at: CalendarInstant = this.clock.now(),
  ): string {
    return holidayCutoff(versions, at);
  }

  async readAt(
    at: CalendarInstant = this.clock.now(),
    manager?: EntityManager,
  ) {
    const capturedAt = isoInstant(at);

    return timelineAt(await this.repository.timeline(manager), capturedAt);
  }

  async readSnapshot(
    workDate: string,
    recorded?: Readonly<ScheduleSnapshot>,
    manager?: EntityManager,
  ): Promise<Readonly<ScheduleSnapshot>> {
    if (recorded) {
      return recordedSnapshot(workDate, recorded);
    }

    return scheduleSnapshot(await this.repository.timeline(manager), workDate);
  }

  async readDay(
    workDate: string,
    manager?: EntityManager,
  ): Promise<Readonly<CalendarDay>> {
    const day = plainDate(workDate);
    const date = day.toString();
    const [versions, holiday] = await Promise.all([
      this.repository.timeline(manager),
      this.repository.holiday(date, manager),
    ]);
    const version = scheduleForDate(versions, date);
    const kind = holiday
      ? 'HOLIDAY'
      : version.workingDays.includes(day.dayOfWeek)
        ? 'WORKING_DAY'
        : 'REST_DAY';

    return Object.freeze({
      workDate: date,
      timeZone: version.timeZone,
      isoWeekday: day.dayOfWeek,
      kind,
      schedule: kind === 'WORKING_DAY' ? snapshotForDate(version, date) : null,
      holiday,
    });
  }
}
