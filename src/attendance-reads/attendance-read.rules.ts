import type {
  AttendanceDay,
  MonitoringPage,
  Pagination,
} from '../attendance-rpc/rpc.responses';
import type { SavedSchedule } from '../work-calendar/calendar.types';
import { dateAt, plainDate } from '../work-calendar/calendar-time';
import { scheduleForDate } from '../work-calendar/schedule.timeline';
import { snapshotForDate } from '../work-calendar/schedule.rules';
import { dayProjection } from '../attendance/attendance.rules';
import { ProblemException } from '../http/problem';

type DayStatus = AttendanceDay['status'];

export interface DatedContext {
  date: string;
  version: SavedSchedule | null;
  holiday: boolean;
  status: DayStatus;
  creationCutoff: Date;
}

export function historyDates(from: string, to: string): string[] {
  const first = plainDate(from);
  const last = plainDate(to);
  const days = first.until(last).days;

  if (days < 0 || days >= 366) {
    throw new ProblemException(
      400,
      'VALIDATION_FAILED',
      'Use an ordered date range of at most 366 days',
    );
  }

  return Array.from({ length: days + 1 }, (_, index) =>
    first.add({ days: index }).toString(),
  ).reverse();
}

export function datedContext(
  date: string,
  versions: readonly SavedSchedule[],
  holiday: boolean,
): DatedContext {
  plainDate(date);
  let version: SavedSchedule | null;

  try {
    version = scheduleForDate(versions, date);
  } catch (error) {
    if (
      !(error instanceof ProblemException) ||
      error.code !== 'SCHEDULE_NOT_CONFIGURED'
    ) {
      throw error;
    }

    version = null;
  }

  const status = !version
    ? 'UNCONFIGURED'
    : holiday
      ? 'HOLIDAY'
      : version.workingDays.includes(plainDate(date).dayOfWeek)
        ? 'NOT_CHECKED_IN'
        : 'REST_DAY';
  // Bound account visibility by the end of the requested work date, in its zone.
  const creationCutoff = new Date(
    plainDate(date)
      .add({ days: 1 })
      .toZonedDateTime(version?.timeZone ?? 'UTC').epochMilliseconds,
  );

  return { date, version, holiday, status, creationCutoff };
}

export function existedOnDate(createdAt: Date, context: DatedContext): boolean {
  return context.date >= dateAt(createdAt, context.version?.timeZone ?? 'UTC');
}

export function projectedDay(
  context: DatedContext,
  at: Date,
  actual: AttendanceDay['attendance'],
  hasOpen = false,
): AttendanceDay {
  if (actual) {
    return dayProjection(context.date, undefined, false, at, actual);
  }

  const working = context.status === 'NOT_CHECKED_IN';
  const choice = !context.version
    ? undefined
    : working
      ? {
          workDate: context.date,
          working: true as const,
          schedule: snapshotForDate(context.version, context.date),
        }
      : { workDate: context.date, working: false as const, schedule: null };
  const day = dayProjection(context.date, choice, context.holiday, at, null);

  if (day.canCheckIn && hasOpen) {
    return { ...day, canCheckIn: false, blockReason: 'ALREADY_CHECKED_IN' };
  }

  return day;
}

export function pagination(
  page: number,
  pageSize: number,
  totalItems: number,
): Pagination {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / pageSize),
  };
}

export interface StatusTotal {
  status: DayStatus;
  total: string | number;
  late: string | number | null;
}

export function monitoringTotals(rows: readonly StatusTotal[]): {
  totalItems: number;
  summary: MonitoringPage['summary'];
} {
  const summary: MonitoringPage['summary'] = {
    notCheckedIn: 0,
    working: 0,
    completed: 0,
    late: 0,
    holiday: 0,
    restDay: 0,
    unconfigured: 0,
  };
  const fields = {
    NOT_CHECKED_IN: 'notCheckedIn',
    WORKING: 'working',
    COMPLETED: 'completed',
    HOLIDAY: 'holiday',
    REST_DAY: 'restDay',
    UNCONFIGURED: 'unconfigured',
  } as const;
  let totalItems = 0;

  for (const row of rows) {
    const total = Number(row.total);
    summary[fields[row.status]] += total;
    summary.late += Number(row.late ?? 0);
    totalItems += total;
  }

  return { totalItems, summary };
}
