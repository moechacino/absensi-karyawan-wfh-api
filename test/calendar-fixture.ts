import type {
  SavedSchedule,
  ScheduleProposal,
} from '../src/work-calendar/calendar.types';

export function scheduleFixture(
  overrides: Partial<SavedSchedule> = {},
): SavedSchedule {
  return {
    id: '00000007-1111-4111-8111-000000000007',
    workingDays: [1, 2, 3, 4, 5],
    startTime: '08:00',
    endTime: '16:00',
    endDayOffset: 0,
    timeZone: 'Asia/Jakarta',
    effectiveFrom: '2026-11-01',
    effectiveAt: '2026-10-31T17:00:00.000Z',
    supersededAt: null,
    ...overrides,
  };
}

export function proposalFixture(
  overrides: Partial<ScheduleProposal> = {},
): ScheduleProposal {
  return {
    expectedVersion: 0,
    workingDays: [1, 2, 3, 4, 5],
    startTime: '08:00',
    endTime: '16:00',
    endDayOffset: 0,
    timeZone: 'Asia/Jakarta',
    effectiveFrom: '2026-11-09',
    ...overrides,
  };
}
