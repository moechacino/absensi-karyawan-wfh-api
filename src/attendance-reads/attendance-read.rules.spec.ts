import {
  datedContext,
  existedOnDate,
  historyDates,
  monitoringTotals,
  pagination,
  projectedDay,
} from './attendance-read.rules';
import type { SavedSchedule } from '../work-calendar/calendar.types';
import type { Attendance } from '../attendance-rpc/rpc.responses';

const version: SavedSchedule = {
  id: 'schedule',
  workingDays: [1, 2, 3, 4, 5],
  startTime: '08:00',
  endTime: '16:00',
  endDayOffset: 0,
  timeZone: 'Asia/Jakarta',
  effectiveFrom: '2026-11-01',
  effectiveAt: '2026-10-31T17:00:00.000Z',
  supersededAt: null,
};
const now = new Date('2026-11-09T01:00:00.000Z');

describe('dated attendance read rules', () => {
  it('enumerates inclusive dates newest first, including leap day and year-end', () => {
    expect(historyDates('2024-02-28', '2024-03-01')).toEqual([
      '2024-03-01',
      '2024-02-29',
      '2024-02-28',
    ]);
    expect(historyDates('2026-12-31', '2027-01-01')).toEqual([
      '2027-01-01',
      '2026-12-31',
    ]);
    expect(historyDates('2024-01-01', '2024-12-31')).toHaveLength(366);
    expect(historyDates('2026-11-09', '2026-11-09')).toEqual(['2026-11-09']);
  });

  it.each([
    ['2026-11-10', '2026-11-09'],
    ['2024-01-01', '2025-01-01'],
    ['2026-02-30', '2026-03-01'],
  ])('rejects invalid or oversized range %s..%s', (from, to) => {
    expect(() => historyDates(from, to)).toThrow();
  });

  it('projects before first schedule coverage as UNCONFIGURED rather than inventing an old schedule', () => {
    const context = datedContext('2026-10-31', [version], false);
    expect(projectedDay(context, now, null)).toMatchObject({
      status: 'UNCONFIGURED',
      schedule: null,
      attendance: null,
      canCheckIn: false,
      blockReason: 'SCHEDULE_NOT_CONFIGURED',
    });
  });

  it('projects working/rest/holiday dates without creating actual records', () => {
    expect(
      projectedDay(datedContext('2026-11-09', [version], false), now, null),
    ).toMatchObject({
      status: 'NOT_CHECKED_IN',
      canCheckIn: true,
      attendance: null,
    });
    expect(
      projectedDay(datedContext('2026-11-08', [version], false), now, null),
    ).toMatchObject({ status: 'REST_DAY', schedule: null, canCheckIn: false });
    expect(
      projectedDay(datedContext('2026-11-09', [version], true), now, null),
    ).toMatchObject({
      status: 'HOLIDAY',
      blockReason: 'COMPANY_HOLIDAY',
      schedule: null,
    });
  });

  it('disables another check-in while an open attendance exists outside the requested range', () => {
    expect(
      projectedDay(
        datedContext('2026-11-09', [version], false),
        now,
        null,
        true,
      ),
    ).toMatchObject({
      status: 'NOT_CHECKED_IN',
      canCheckIn: false,
      blockReason: 'ALREADY_CHECKED_IN',
    });
  });

  it('uses current clock only for flags on the exact requested date, including overnight windows', () => {
    const night = {
      ...version,
      startTime: '22:00',
      endTime: '06:00',
      endDayOffset: 1 as const,
    };
    const context = datedContext('2026-11-09', [night], false);
    expect(
      projectedDay(context, new Date('2026-11-09T18:00:00.000Z'), null),
    ).toMatchObject({ canCheckIn: true, workDate: '2026-11-09' });
    expect(
      projectedDay(context, new Date('2026-11-09T23:00:00.000Z'), null),
    ).toMatchObject({
      canCheckIn: false,
      blockReason: 'CHECK_IN_WINDOW_CLOSED',
    });
  });

  it.each(['WORKING', 'COMPLETED'] as const)(
    'preserves an actual %s snapshot across holidays or invalid new shift times',
    (state) => {
      const broken = {
        ...version,
        timeZone: 'America/New_York',
        startTime: '01:30',
        endTime: '09:30',
      };
      const original = {
        id: 'record',
        workDate: '2026-11-01',
        state,
        schedule: { timeZone: 'Asia/Jakarta' },
      } as Attendance;
      const context = datedContext('2026-11-01', [broken], true);
      const day = projectedDay(context, now, original);
      expect(day).toMatchObject({
        status: state,
        attendance: original,
        schedule: original.schedule,
        canCheckOut: state === 'WORKING',
      });
    },
  );

  it('does not resolve shift instants on rest days or holidays but rejects applicable invalid working instants', () => {
    const broken = {
      ...version,
      timeZone: 'America/New_York',
      startTime: '01:30',
      endTime: '09:30',
    };
    expect(
      projectedDay(datedContext('2026-11-01', [broken], false), now, null)
        .status,
    ).toBe('REST_DAY');
    expect(
      projectedDay(
        datedContext('2026-11-01', [{ ...broken, workingDays: [7] }], true),
        now,
        null,
      ).status,
    ).toBe('HOLIDAY');
    expect(() =>
      projectedDay(
        datedContext('2026-11-01', [{ ...broken, workingDays: [7] }], false),
        now,
        null,
      ),
    ).toThrow();
  });

  it('compares account creation by the applicable company date, not UTC or exact shift start', () => {
    const context = datedContext('2026-11-09', [version], false);
    expect(existedOnDate(new Date('2026-11-09T16:59:59.999Z'), context)).toBe(
      true,
    );
    expect(existedOnDate(new Date('2026-11-09T17:00:00.000Z'), context)).toBe(
      false,
    );
    expect(context.creationCutoff.toISOString()).toBe(
      '2026-11-09T17:00:00.000Z',
    );
  });

  it('uses the first valid next-date boundary when midnight has a DST gap', () => {
    const context = datedContext(
      '2026-03-07',
      [
        {
          ...version,
          effectiveAt: '2026-01-01T00:00:00.000Z',
          timeZone: 'America/Havana',
        },
      ],
      false,
    );
    expect(context.creationCutoff.toISOString()).toBe(
      '2026-03-08T05:00:00.000Z',
    );
  });

  it('keeps late as an overlapping summary count and returns totals before pagination', () => {
    const result = monitoringTotals([
      { status: 'WORKING', total: '3', late: '2' },
      { status: 'COMPLETED', total: '2', late: '1' },
      { status: 'REST_DAY', total: '4', late: null },
    ]);
    expect(result).toEqual({
      totalItems: 9,
      summary: {
        notCheckedIn: 0,
        working: 3,
        completed: 2,
        late: 3,
        holiday: 0,
        restDay: 4,
        unconfigured: 0,
      },
    });
    expect(pagination(2, 4, result.totalItems)).toEqual({
      page: 2,
      pageSize: 4,
      totalItems: 9,
      totalPages: 3,
    });
    expect(pagination(1, 20, 0).totalPages).toBe(0);
  });
});
