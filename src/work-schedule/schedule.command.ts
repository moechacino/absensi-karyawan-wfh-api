import type { ScheduleProposal } from '../work-calendar/calendar.types';

export function scheduleCommand(input: ScheduleProposal) {
  return {
    opensMinutesBeforeStart: input.opensMinutesBeforeStart ?? 15,
    expectedVersion: input.expectedVersion,
    workingDays: [...input.workingDays].sort((a, b) => a - b),
    startTime: input.startTime,
    endTime: input.endTime,
    endDayOffset: input.endDayOffset,
    timeZone: input.timeZone,
    effectiveFrom: input.effectiveFrom,
  };
}
