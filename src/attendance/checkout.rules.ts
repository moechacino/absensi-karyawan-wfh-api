import type { SavedSchedule } from '../work-calendar/calendar.types';
import { addDate, dateAt } from '../work-calendar/calendar-time';
import { scheduleForDate } from '../work-calendar/schedule.timeline';
import { snapshotForDate } from '../work-calendar/schedule.rules';
import { ProblemException } from '../http/problem';
import type { AttendanceEntity } from '../database/entities';

export function checkoutDeadline(
  versions: readonly SavedSchedule[],
  workDate: string,
  holidays: readonly string[],
): string | null {
  if (!versions.length) return null;

  const excluded = new Set(holidays);
  const lastDate = [
    workDate,
    ...holidays,
    ...versions.map((v) => dateAt(v.effectiveAt, v.timeZone)),
  ]
    .toSorted()
    .at(-1)!;
  const through = addDate(lastDate, 7);

  for (
    let date = addDate(workDate, 1);
    date <= through;
    date = addDate(date, 1)
  ) {
    if (excluded.has(date)) continue;

    try {
      const version = scheduleForDate(versions, date);
      const weekday = Temporal.PlainDate.from(date).dayOfWeek;
      if (!version.workingDays.includes(weekday)) continue;
      const shift = snapshotForDate(version, date);

      return Temporal.Instant.from(shift.plannedStartAt)
        .subtract({ minutes: version.opensMinutesBeforeStart ?? 15 })
        .toString({ fractionalSecondDigits: 3 });
    } catch (error) {
      if (
        !(error instanceof ProblemException) ||
        !['SCHEDULE_NOT_CONFIGURED', 'INVALID_LOCAL_TIME'].includes(error.code)
      )
        throw error;
    }
  }

  return null;
}

export function checkoutDeadlines(
  records: readonly AttendanceEntity[],
  versions: readonly SavedSchedule[],
  holidays: readonly string[],
): Map<string, string | null> {
  const byDate = new Map<string, string | null>();

  return new Map(
    records.map((row) => {
      if (!byDate.has(row.workDate))
        byDate.set(
          row.workDate,
          checkoutDeadline(versions, row.workDate, holidays),
        );

      return [row.id, byDate.get(row.workDate)!];
    }),
  );
}

export function checkoutTiming(checkOutAt: Date | null, plannedEndAt: Date) {
  if (!checkOutAt)
    return { checkOutPunctuality: null, earlyCheckOutSeconds: null };
  const difference = checkOutAt.getTime() - plannedEndAt.getTime();

  return {
    checkOutPunctuality:
      difference < 0
        ? ('EARLY' as const)
        : difference === 0
          ? ('ON_TIME' as const)
          : ('LATE' as const),
    earlyCheckOutSeconds:
      difference < 0 ? Math.max(1, Math.floor(-difference / 1000)) : 0,
  };
}
