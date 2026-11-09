import { ProblemException } from '../http/problem';
import type { ScheduleSnapshot } from '../attendance-rpc/rpc.responses';

import {
  addDate,
  dateAt,
  instant,
  localInstant,
  plainDate,
  supportedTimeZone,
  timeMinutes,
} from './calendar-time';
import type { CalendarInstant } from './calendar-time';
import type {
  SavedSchedule,
  ScheduleActivation,
  ScheduleDefinition,
  ScheduleProposal,
} from './calendar.types';

export function scheduleDefinition(
  input: ScheduleDefinition,
): ScheduleDefinition {
  if (
    !input.workingDays.length ||
    input.workingDays.length > 7 ||
    new Set(input.workingDays).size !== input.workingDays.length ||
    input.workingDays.some(
      (day) => !Number.isInteger(day) || day < 1 || day > 7,
    )
  ) {
    throw new ProblemException(
      422,
      'INVALID_WORKING_DAYS',
      'Invalid working days',
    );
  }

  const duration =
    input.endDayOffset * 1440 +
    timeMinutes(input.endTime) -
    timeMinutes(input.startTime);

  if (
    (input.endDayOffset !== 0 && input.endDayOffset !== 1) ||
    duration <= 0 ||
    duration >= 1440
  ) {
    throw new ProblemException(
      422,
      'INVALID_DURATION',
      'Invalid work duration',
    );
  }

  return Object.freeze({
    workingDays: Object.freeze([...input.workingDays]),
    startTime: input.startTime,
    endTime: input.endTime,
    endDayOffset: input.endDayOffset,
    timeZone: supportedTimeZone(input.timeZone),
  });
}

export function scheduleActivation(
  input: ScheduleProposal,
  at: CalendarInstant,
): ScheduleActivation {
  const definition = scheduleDefinition(input);
  const effectiveFrom = plainDate(input.effectiveFrom).toString();
  const comparisonDate = dateAt(at, definition.timeZone);

  if (effectiveFrom < comparisonDate) {
    throw new ProblemException(
      422,
      'PAST_DATE_IMMUTABLE',
      'Past dates cannot be changed',
    );
  }

  if (effectiveFrom === comparisonDate) {
    return Object.freeze({
      comparisonDate,
      activationMode: 'ON_SAVE',
      effectiveAt: null,
    });
  }

  return Object.freeze({
    comparisonDate,
    activationMode: 'AT_INSTANT',
    effectiveAt: localInstant(effectiveFrom, '00:00', definition.timeZone),
  });
}

export function snapshotForDate(
  version: SavedSchedule,
  workDate: string,
): Readonly<ScheduleSnapshot> {
  const definition = scheduleDefinition(version);
  const day = plainDate(workDate).toString();
  const plannedStartAt = localInstant(
    day,
    definition.startTime,
    definition.timeZone,
  );
  const plannedEndAt = localInstant(
    addDate(day, definition.endDayOffset),
    definition.endTime,
    definition.timeZone,
  );

  if (
    Temporal.Instant.compare(instant(plannedEndAt), instant(plannedStartAt)) <=
    0
  ) {
    throw new ProblemException(
      422,
      'INVALID_DURATION',
      'Invalid work duration',
    );
  }

  return Object.freeze({
    scheduleVersionId: version.id,
    workDate: day,
    timeZone: definition.timeZone,
    plannedStartAt,
    plannedEndAt,
  });
}

export function recordedSnapshot(
  workDate: string,
  snapshot: Readonly<ScheduleSnapshot>,
): Readonly<ScheduleSnapshot> {
  if (plainDate(workDate).toString() !== snapshot.workDate) {
    throw new ProblemException(
      400,
      'VALIDATION_FAILED',
      'Snapshot work date does not match',
    );
  }

  // Preserve the recorded offsets/instants verbatim; do not resolve them under new zone data.
  return Object.freeze({
    scheduleVersionId: snapshot.scheduleVersionId,
    workDate: snapshot.workDate,
    timeZone: snapshot.timeZone,
    plannedStartAt: snapshot.plannedStartAt,
    plannedEndAt: snapshot.plannedEndAt,
  });
}
