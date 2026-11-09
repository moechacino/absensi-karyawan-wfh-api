import { ProblemException } from '../http/problem';
import type { ScheduleSnapshot } from '../attendance-rpc/rpc.responses';

import { dateAt, instant, isoInstant, plainDate } from './calendar-time';
import type { CalendarInstant } from './calendar-time';
import type {
  SavedSchedule,
  ScheduleProposal,
  ScheduleSavePlan,
} from './calendar.types';
import {
  recordedSnapshot,
  scheduleActivation,
  scheduleDefinition,
  snapshotForDate,
} from './schedule.rules';

function freezeVersion(version: SavedSchedule): SavedSchedule {
  return Object.freeze({ ...version, ...scheduleDefinition(version) });
}

export function savedTimeline(
  versions: readonly SavedSchedule[],
): readonly SavedSchedule[] {
  const ordered = versions
    .filter(
      (version) =>
        !version.supersededAt ||
        Temporal.Instant.compare(
          instant(version.effectiveAt),
          instant(version.supersededAt),
        ) < 0,
    )
    .toSorted((left, right) =>
      Temporal.Instant.compare(
        instant(left.effectiveAt),
        instant(right.effectiveAt),
      ),
    );

  for (let index = 1; index < ordered.length; index++) {
    if (
      Temporal.Instant.compare(
        instant(ordered[index - 1].effectiveAt),
        instant(ordered[index].effectiveAt),
      ) === 0
    ) {
      throw new ProblemException(
        500,
        'INTERNAL_ERROR',
        'Schedule timeline is inconsistent',
      );
    }
  }

  return Object.freeze(ordered.map(freezeVersion));
}

export function timelineAt(
  versions: readonly SavedSchedule[],
  at: CalendarInstant,
) {
  const now = instant(at);
  const timeline = savedTimeline(versions);
  const latest = timeline.findLast(
    (version) =>
      Temporal.Instant.compare(instant(version.effectiveAt), now) <= 0,
  );
  const current =
    latest &&
    (!latest.supersededAt ||
      Temporal.Instant.compare(now, instant(latest.supersededAt)) < 0)
      ? latest
      : null;
  const upcoming =
    timeline.find(
      (version) =>
        Temporal.Instant.compare(instant(version.effectiveAt), now) > 0,
    ) ?? null;

  return Object.freeze({ current, upcoming });
}

export function scheduleForDate(
  versions: readonly SavedSchedule[],
  workDate: string,
): SavedSchedule {
  const day = plainDate(workDate).toString();
  const version = savedTimeline(versions).findLast(
    (candidate) => dateAt(candidate.effectiveAt, candidate.timeZone) <= day,
  );

  if (!version) {
    throw new ProblemException(
      409,
      'SCHEDULE_NOT_CONFIGURED',
      'No saved schedule covers this date',
    );
  }

  if (version.supersededAt) {
    const end = instant(version.supersededAt).toZonedDateTimeISO(
      version.timeZone,
    );
    const endDate = end.toPlainDate().toString();

    if (
      endDate < day ||
      (endDate === day && end.toPlainTime().equals('00:00'))
    ) {
      throw new ProblemException(
        409,
        'SCHEDULE_NOT_CONFIGURED',
        'No saved schedule covers this date',
      );
    }
  }

  return version;
}

export function scheduleSnapshot(
  versions: readonly SavedSchedule[],
  workDate: string,
  recorded?: Readonly<ScheduleSnapshot>,
): Readonly<ScheduleSnapshot> {
  if (recorded) {
    return recordedSnapshot(workDate, recorded);
  }

  return snapshotForDate(scheduleForDate(versions, workDate), workDate);
}

export function planScheduleSave(
  input: ScheduleProposal,
  versions: readonly SavedSchedule[],
  at: CalendarInstant,
): ScheduleSavePlan {
  const saveAt = isoInstant(at);
  const activation = scheduleActivation(input, saveAt);
  const { current, upcoming } = timelineAt(versions, at);
  const pending = savedTimeline(versions).filter(
    (version) =>
      Temporal.Instant.compare(instant(version.effectiveAt), instant(at)) > 0,
  );

  if (pending.length > 1) {
    throw new ProblemException(
      500,
      'INTERNAL_ERROR',
      'Schedule timeline has multiple pending versions',
    );
  }

  return Object.freeze({
    ...activation,
    saveAt,
    activateAt: activation.effectiveAt ?? saveAt,
    closeCurrentId:
      activation.activationMode === 'ON_SAVE' ? (current?.id ?? null) : null,
    replacePendingIds: Object.freeze(upcoming ? [upcoming.id] : []),
  });
}

export function holidayCutoff(
  versions: readonly SavedSchedule[],
  at: CalendarInstant,
): string {
  const { current } = timelineAt(versions, at);

  if (!current) {
    throw new ProblemException(
      409,
      'SCHEDULE_NOT_CONFIGURED',
      'An active schedule is required for holiday changes',
    );
  }

  return dateAt(at, current.timeZone);
}
