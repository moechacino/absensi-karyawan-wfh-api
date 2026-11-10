import type { ScheduleVersionEntity } from '../database/entities';
import type { SavedSchedule } from '../work-calendar/calendar.types';
import type {
  ScheduleVersion,
  WorkSchedule,
} from '../attendance-rpc/rpc.responses';
import { timelineAt } from '../work-calendar/schedule.timeline';
import type { CalendarInstant } from '../work-calendar/calendar-time';

export function savedSchedule(row: ScheduleVersionEntity): SavedSchedule {
  return {
    id: row.id,
    opensMinutesBeforeStart: row.opensMinutesBeforeStart ?? 15,
    workingDays: row.workingDays as number[],
    startTime: row.startTime,
    endTime: row.endTime,
    endDayOffset: row.endDayOffset as 0 | 1,
    timeZone: row.timeZone,
    effectiveFrom: row.effectiveFrom,
    effectiveAt: row.effectiveAt.toISOString(),
    supersededAt: row.supersededAt?.toISOString() ?? null,
  };
}

export function scheduleVersion(
  row: ScheduleVersionEntity,
  currentId?: string,
  upcomingId?: string,
): ScheduleVersion {
  return {
    id: row.id,
    opensMinutesBeforeStart: row.opensMinutesBeforeStart ?? 15,
    workingDays: [...row.workingDays] as number[],
    startTime: row.startTime,
    endTime: row.endTime,
    endDayOffset: row.endDayOffset as 0 | 1,
    timeZone: row.timeZone,
    effectiveFrom: row.effectiveFrom,
    effectiveAt: row.effectiveAt.toISOString(),
    state:
      row.id === currentId
        ? 'ACTIVE'
        : row.id === upcomingId
          ? 'SCHEDULED'
          : 'SUPERSEDED',
    createdAt: row.createdAt.toISOString(),
    createdBy: { id: row.actor.id, fullName: row.actor.fullName },
  };
}

export function scheduleView(
  version: number,
  rows: ScheduleVersionEntity[],
  at: CalendarInstant,
): WorkSchedule {
  const state = timelineAt(rows.map(savedSchedule), at);
  const current = rows.find((row) => row.id === state.current?.id);
  const upcoming = rows.find((row) => row.id === state.upcoming?.id);

  return {
    version,
    current: current
      ? scheduleVersion(current, current.id, upcoming?.id)
      : null,
    upcoming: upcoming
      ? scheduleVersion(upcoming, current?.id, upcoming.id)
      : null,
    checkInPolicy: {
      opensMinutesBeforeStart: current?.opensMinutesBeforeStart ?? 15,
      lateAfterMinutes: 0,
    },
  };
}
