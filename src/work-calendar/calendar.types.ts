import type { ScheduleSnapshot } from '../attendance-rpc/rpc.responses';

export interface ScheduleDefinition {
  readonly opensMinutesBeforeStart?: number;
  readonly workingDays: readonly number[];
  readonly startTime: string;
  readonly endTime: string;
  readonly endDayOffset: 0 | 1;
  readonly timeZone: string;
}

export interface ScheduleProposal extends ScheduleDefinition {
  readonly expectedVersion: number;
  readonly effectiveFrom: string;
}

export interface SavedSchedule extends ScheduleDefinition {
  readonly id: string;
  readonly effectiveFrom: string;
  readonly effectiveAt: string;
  readonly supersededAt: string | null;
}

export interface ScheduleActivation {
  readonly comparisonDate: string;
  readonly activationMode: 'ON_SAVE' | 'AT_INSTANT';
  readonly effectiveAt: string | null;
}

export interface ScheduleSavePlan extends ScheduleActivation {
  readonly saveAt: string;
  readonly activateAt: string;
  readonly closeCurrentId: string | null;
  readonly replacePendingIds: readonly string[];
}

export interface HolidayDate {
  readonly date: string;
  readonly name: string;
  readonly category: 'COMPANY' | 'PUBLIC' | 'OTHER';
}

export interface CalendarDay {
  readonly workDate: string;
  readonly timeZone: string;
  readonly isoWeekday: number;
  readonly kind: 'WORKING_DAY' | 'REST_DAY' | 'HOLIDAY';
  readonly schedule: Readonly<ScheduleSnapshot> | null;
  readonly holiday: Readonly<HolidayDate> | null;
}
