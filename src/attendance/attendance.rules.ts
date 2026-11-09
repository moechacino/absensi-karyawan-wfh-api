import type {
  AttendanceDay,
  CheckInWindow,
  Home,
  ScheduleSnapshot,
} from '../attendance-rpc/rpc.responses';
import type { SavedSchedule } from '../work-calendar/calendar.types';
import {
  addDate,
  dateAt,
  instant,
  plainDate,
} from '../work-calendar/calendar-time';
import { snapshotForDate } from '../work-calendar/schedule.rules';
import {
  scheduleForDate,
  timelineAt,
} from '../work-calendar/schedule.timeline';
import { ProblemException } from '../http/problem';

export type AttendanceCandidate =
  | { workDate: string; schedule: ScheduleSnapshot; working: true }
  | { workDate: string; schedule: null; working: false };

export function checkInWindow(schedule: ScheduleSnapshot): CheckInWindow {
  return {
    opensAt: instant(schedule.plannedStartAt)
      .subtract({ minutes: 15 })
      .toString({ fractionalSecondDigits: 3 }),
    deadlineAt: schedule.plannedStartAt,
    closesAt: schedule.plannedEndAt,
  };
}

export function candidateDates(
  versions: readonly SavedSchedule[],
  at: Date,
): string[] {
  const current = timelineAt(versions, at).current;

  if (!current) {
    return [];
  }

  // Include neighbouring work dates for overnight and pre-midnight early windows.
  // Historical zones cover a shift whose zone changed while it was still open.
  const zones = new Set(
    versions
      .filter(
        (row) =>
          instant(row.effectiveAt).epochMilliseconds <=
            at.getTime() + 15 * 60000 &&
          (!row.supersededAt ||
            instant(row.supersededAt).epochMilliseconds >=
              at.getTime() - 86400000),
      )
      .map((row) => row.timeZone),
  );
  zones.add(current.timeZone);
  const dates = new Set(
    [...zones].flatMap((zone) =>
      [-1, 0, 1].map((offset) => addDate(dateAt(at, zone), offset)),
    ),
  );

  return [...dates].sort();
}

export function candidates(
  versions: readonly SavedSchedule[],
  at: Date,
  holidays: readonly string[] = [],
  recorded: readonly ScheduleSnapshot[] = [],
): AttendanceCandidate[] {
  const companyDate = dateAt(
    at,
    timelineAt(versions, at).current?.timeZone ?? 'UTC',
  );

  return candidateDates(versions, at).flatMap(
    (workDate): AttendanceCandidate[] => {
      try {
        const snapshot = recorded.find((row) => row.workDate === workDate);

        if (snapshot) {
          return [{ workDate, schedule: snapshot, working: true }];
        }

        const version = scheduleForDate(versions, workDate);

        if (
          !version.workingDays.includes(plainDate(workDate).dayOfWeek) ||
          holidays.includes(workDate)
        ) {
          return [{ workDate, schedule: null, working: false }];
        }

        return [
          {
            workDate,
            schedule: snapshotForDate(version, workDate),
            working: true,
          },
        ];
      } catch (error) {
        if (
          error instanceof ProblemException &&
          (error.code === 'SCHEDULE_NOT_CONFIGURED' ||
            (error.code === 'INVALID_LOCAL_TIME' && workDate !== companyDate))
        ) {
          return [];
        }

        throw error;
      }
    },
  );
}

export function selectDay(
  choices: readonly AttendanceCandidate[],
  companyDate: string,
  at: Date,
): AttendanceCandidate | undefined {
  const withinWindow = choices
    .filter(
      (choice): choice is Extract<AttendanceCandidate, { working: true }> => {
        if (!choice.working) {
          return false;
        }

        const window = checkInWindow(choice.schedule);

        return (
          at.getTime() >= Date.parse(window.opensAt) &&
          at.getTime() < Date.parse(window.closesAt)
        );
      },
    )
    .toSorted(
      (left, right) =>
        Date.parse(right.schedule.plannedStartAt) -
        Date.parse(left.schedule.plannedStartAt),
    );

  return (
    withinWindow[0] ?? choices.find((choice) => choice.workDate === companyDate)
  );
}

export function dayProjection(
  workDate: string,
  choice: AttendanceCandidate | undefined,
  holiday: boolean,
  at: Date,
  attendance: AttendanceDay['attendance'],
): AttendanceDay {
  if (attendance) {
    return {
      workDate: attendance.workDate,
      status: attendance.state,
      schedule: attendance.schedule,
      attendance,
      canCheckIn: false,
      canCheckOut: attendance.state === 'WORKING',
      blockReason:
        attendance.state === 'WORKING'
          ? 'ALREADY_CHECKED_IN'
          : 'ALREADY_CHECKED_OUT',
    };
  }

  const schedule = choice?.schedule ?? null;
  let blockReason: AttendanceDay['blockReason'] = null;
  let status: AttendanceDay['status'] = 'NOT_CHECKED_IN';

  if (!choice) {
    status = 'UNCONFIGURED';
    blockReason = 'SCHEDULE_NOT_CONFIGURED';
  } else if (holiday) {
    status = 'HOLIDAY';
    blockReason = 'COMPANY_HOLIDAY';
  } else if (!choice.working) {
    status = 'REST_DAY';
    blockReason = 'REST_DAY';
  } else {
    const window = checkInWindow(choice.schedule);
    blockReason =
      at.getTime() < Date.parse(window.opensAt)
        ? 'CHECK_IN_TOO_EARLY'
        : at.getTime() >= Date.parse(window.closesAt)
          ? 'CHECK_IN_WINDOW_CLOSED'
          : null;
  }

  return {
    workDate,
    status,
    schedule: status === 'HOLIDAY' || status === 'REST_DAY' ? null : schedule,
    attendance: null,
    canCheckIn: blockReason === null,
    canCheckOut: false,
    blockReason,
  };
}

export function requireCheckIn(home: Home): ScheduleSnapshot {
  if (!home.day.canCheckIn || !home.day.schedule) {
    const reason = home.day.attendance
      ? 'ALREADY_CHECKED_IN'
      : home.day.blockReason;
    const code =
      reason === 'COMPANY_HOLIDAY' || reason === 'REST_DAY'
        ? 'ATTENDANCE_NOT_REQUIRED'
        : (reason ?? 'SCHEDULE_NOT_CONFIGURED');
    throw new ProblemException(409, code, 'Check-in is unavailable');
  }

  return home.day.schedule;
}

export function punctuality(
  receivedAt: Date,
  plannedStartAt: string,
): { punctuality: 'ON_TIME' | 'LATE'; lateSeconds: number } {
  const elapsed = receivedAt.getTime() - Date.parse(plannedStartAt);

  return elapsed <= 0
    ? { punctuality: 'ON_TIME', lateSeconds: 0 }
    : {
        punctuality: 'LATE',
        lateSeconds: Math.max(1, Math.floor(elapsed / 1000)),
      };
}

export function checkoutChanges(
  record: { version: number; checkOutAt: Date | null; checkInAt: Date },
  expectedVersion: number,
  at: Date,
): { checkOutAt: Date; durationSeconds: number; version: number } {
  if (record.version !== expectedVersion) {
    throw new ProblemException(409, 'VERSION_CONFLICT', 'Version conflict', {
      details: { expectedVersion, actualVersion: record.version },
    });
  }

  if (record.checkOutAt) {
    throw new ProblemException(
      409,
      'ALREADY_CHECKED_OUT',
      'Already checked out',
    );
  }

  if (at < record.checkInAt) {
    throw new ProblemException(
      409,
      'CHECK_IN_CONTEXT_STALE',
      'Server time precedes check-in',
    );
  }

  return {
    checkOutAt: at,
    durationSeconds: Math.floor(
      (at.getTime() - record.checkInAt.getTime()) / 1000,
    ),
    version: record.version + 1,
  };
}
