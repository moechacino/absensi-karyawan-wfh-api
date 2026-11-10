import {
  candidates,
  checkInWindow,
  checkoutChanges,
  dayProjection,
  punctuality,
  requireCheckIn,
  selectDay,
} from './attendance.rules';
import type { SavedSchedule } from '../work-calendar/calendar.types';
import type { Attendance, Home } from '../attendance-rpc/rpc.responses';

const version: SavedSchedule = {
  id: 'schedule',
  workingDays: [1, 2, 3, 4, 5],
  startTime: '08:00',
  endTime: '16:00',
  endDayOffset: 0,
  timeZone: 'Asia/Jakarta',
  effectiveFrom: '2026-01-01',
  effectiveAt: '2025-12-31T17:00:00.000Z',
  supersededAt: null,
};
const at = (time: string) => new Date(`2026-11-09T${time}Z`);

function day(
  time: string,
  changes: Partial<SavedSchedule> = {},
  holidays: string[] = [],
) {
  const now = at(time);
  const choices = candidates([{ ...version, ...changes }], now, holidays);
  const choice = selectDay(choices, '2026-11-09', now);

  return dayProjection(
    choice?.workDate ?? '2026-11-09',
    choice,
    holidays.includes(choice?.workDate ?? ''),
    now,
    null,
  );
}

describe('attendance eligibility and precision', () => {
  it.each([
    ['00:44:59.999', false, 'CHECK_IN_TOO_EARLY'],
    ['00:45:00.000', true, null],
    ['00:59:59.999', true, null],
    ['01:00:00.000', true, null],
    ['01:00:00.001', true, null],
    ['08:59:59.999', true, null],
    ['09:00:00.000', false, 'CHECK_IN_WINDOW_CLOSED'],
    ['09:00:00.001', false, 'CHECK_IN_WINDOW_CLOSED'],
  ])(
    'uses exact upload receipt %s for the open-inclusive/close-exclusive window',
    (time, allowed, reason) => {
      expect(day(time)).toMatchObject({
        canCheckIn: allowed,
        canCheckOut: false,
        blockReason: reason,
      });
    },
  );

  it.each([0, 5, 15, 30, 60, 1440])(
    'honors an HR allowance of %i minutes at the exact boundary',
    (minutes) => {
      const versions = [{ ...version, opensMinutesBeforeStart: minutes }];
      const opens = new Date(
        Date.parse('2026-11-09T01:00:00.000Z') - minutes * 60000,
      );
      const choices = candidates(versions, opens);
      const selected = choices.find(
        (choice) => choice.workDate === '2026-11-09',
      )!;
      expect(
        dayProjection('2026-11-09', selected, false, opens, null).canCheckIn,
      ).toBe(true);
      expect(
        dayProjection(
          '2026-11-09',
          selected,
          false,
          new Date(opens.getTime() - 1),
          null,
        ).blockReason,
      ).toBe('CHECK_IN_TOO_EARLY');
    },
  );

  it('keeps a 20:00–04:00 shift on its starting date and permits checkout at its planned end', () => {
    const versions = [
      {
        ...version,
        startTime: '20:00',
        endTime: '04:00',
        endDayOffset: 1 as const,
        opensMinutesBeforeStart: 15,
      },
    ];
    for (const timestamp of [
      '2026-11-09T12:45:00.000Z',
      '2026-11-09T17:00:00.000Z',
      '2026-11-09T20:59:59.999Z',
    ]) {
      const now = new Date(timestamp);
      const choice = selectDay(
        candidates(versions, now, ['2026-11-10']),
        '2026-11-10',
        now,
      )!;
      expect(choice.workDate).toBe('2026-11-09');
      expect(
        dayProjection(choice.workDate, choice, false, now, null).canCheckIn,
      ).toBe(true);
    }
    expect(day('21:00:00.000', versions[0]).canCheckIn).toBe(false);
    const record = {
      version: 1,
      checkOutAt: null,
      checkInAt: new Date('2026-11-09T13:00:00Z'),
      plannedEndAt: new Date('2026-11-09T21:00:00Z'),
    };
    expect(
      checkoutChanges(record, 1, new Date('2026-11-09T20:59:59.999Z'))
        .checkOutAt,
    ).toEqual(new Date('2026-11-09T20:59:59.999Z'));
    expect(checkoutChanges(record, 1, record.plannedEndAt).checkOutAt).toEqual(
      record.plannedEndAt,
    );
  });

  it.each([
    ['00:45:00.000', 'ON_TIME', 0],
    ['01:00:00.000', 'ON_TIME', 0],
    ['01:00:00.001', 'LATE', 1],
    ['01:00:00.999', 'LATE', 1],
    ['01:00:01.999', 'LATE', 1],
    ['01:00:02.000', 'LATE', 2],
  ] as const)('keeps millisecond punctuality at %s', (time, state, seconds) => {
    expect(punctuality(at(time), '2026-11-09T01:00:00.000Z')).toEqual({
      punctuality: state,
      lateSeconds: seconds,
    });
  });

  it('blocks rest days, holidays and unconfigured schedules without synthetic attendance', () => {
    expect(day('01:00:00.000', { workingDays: [2] })).toMatchObject({
      status: 'REST_DAY',
      canCheckIn: false,
      attendance: null,
      schedule: null,
    });
    expect(day('01:00:00.000', {}, ['2026-11-09'])).toMatchObject({
      status: 'HOLIDAY',
      blockReason: 'COMPANY_HOLIDAY',
      attendance: null,
    });
    expect(candidates([], at('01:00:00.000'))).toEqual([]);
    expect(
      dayProjection('2026-11-09', undefined, false, at('01:00:00.000'), null),
    ).toMatchObject({
      status: 'UNCONFIGURED',
      blockReason: 'SCHEDULE_NOT_CONFIGURED',
    });
  });

  it('uses a prior work date across midnight/year-end for an overnight window', () => {
    const now = new Date('2026-12-31T18:00:00.000Z');
    const choices = candidates(
      [{ ...version, startTime: '22:00', endTime: '06:00', endDayOffset: 1 }],
      now,
    );
    const choice = selectDay(choices, '2027-01-01', now)!;
    expect(choice.workDate).toBe('2026-12-31');
    expect(checkInWindow(choice.schedule!)).toEqual({
      opensAt: '2026-12-31T14:45:00.000Z',
      deadlineAt: '2026-12-31T15:00:00.000Z',
      closesAt: '2026-12-31T23:00:00.000Z',
    });
  });

  it('opens a midnight shift on the preceding calendar date', () => {
    const now = new Date('2026-11-08T16:45:00.000Z');
    const choices = candidates(
      [{ ...version, startTime: '00:00', endTime: '08:00' }],
      now,
    );
    expect(selectDay(choices, '2026-11-08', now)?.workDate).toBe('2026-11-09');
  });

  it('keeps the previous overnight shift eligible when today is a holiday', () => {
    const now = new Date('2026-11-09T18:00:00.000Z');
    const choices = candidates(
      [{ ...version, startTime: '22:00', endTime: '06:00', endDayOffset: 1 }],
      now,
    );
    expect(selectDay(choices, '2026-11-10', now)?.workDate).toBe('2026-11-09');
  });

  it('keeps issued timezone shifts deterministic and ignores unrelated DST gaps on neighbouring dates', () => {
    const now = new Date('2026-03-09T07:00:00.000Z');
    const choices = candidates(
      [
        {
          ...version,
          timeZone: 'America/New_York',
          startTime: '02:30',
          endTime: '10:30',
          workingDays: [1, 2, 3, 4, 5, 6, 7],
        },
      ],
      now,
    );
    expect(
      selectDay(choices, '2026-03-09', now)?.schedule?.plannedStartAt,
    ).toBe('2026-03-09T06:30:00.000Z');
    expect(() =>
      candidates(
        [
          {
            ...version,
            workingDays: [1, 2, 3, 4, 5, 6, 7],
            timeZone: 'America/New_York',
            startTime: '02:30',
            endTime: '10:30',
          },
        ],
        new Date('2026-03-08T07:00:00.000Z'),
      ),
    ).toThrow();
  });

  it.each(['rest', 'holiday'])(
    'does not resolve nonexistent shift times on a DST %s day',
    (kind) => {
      const now = new Date('2026-03-08T07:00:00.000Z');
      const versions = [
        {
          ...version,
          timeZone: 'America/New_York',
          startTime: '02:30',
          endTime: '10:30',
          workingDays: kind === 'rest' ? [1] : [1, 2, 3, 4, 5, 6, 7],
        },
      ];
      const choices = candidates(
        versions,
        now,
        kind === 'holiday' ? ['2026-03-08'] : [],
      );
      const choice = selectDay(choices, '2026-03-08', now);
      expect(
        dayProjection('2026-03-08', choice, kind === 'holiday', now, null),
      ).toMatchObject({
        status: kind === 'holiday' ? 'HOLIDAY' : 'REST_DAY',
        schedule: null,
        canCheckIn: false,
      });
    },
  );

  it('uses a recorded snapshot when a later calendar would make that local time invalid', () => {
    const now = new Date('2026-03-08T07:00:00.000Z');
    const original = {
      scheduleVersionId: version.id,
      workDate: '2026-03-08',
      timeZone: 'Asia/Jakarta',
      plannedStartAt: '2026-03-08T01:00:00.000Z',
      plannedEndAt: '2026-03-08T09:00:00.000Z',
    };
    const choices = candidates(
      [
        {
          ...version,
          timeZone: 'America/New_York',
          startTime: '02:30',
          endTime: '10:30',
          workingDays: [1, 2, 3, 4, 5, 6, 7],
        },
      ],
      now,
      [],
      [original],
    );
    expect(selectDay(choices, '2026-03-08', now)?.schedule).toEqual(original);
  });

  it.each(['WORKING', 'COMPLETED'] as const)(
    'preserves a recorded %s snapshot despite later holiday/schedule changes',
    (state) => {
      const record = {
        state,
        workDate: '2026-11-08',
        schedule: { timeZone: 'Asia/Jakarta' },
      } as Attendance;
      expect(
        dayProjection(
          '2026-11-09',
          undefined,
          true,
          at('01:00:00.000'),
          record,
        ),
      ).toMatchObject({
        status: state,
        workDate: '2026-11-08',
        attendance: record,
        schedule: record.schedule,
        canCheckIn: false,
        canCheckOut: state === 'WORKING',
      });
      expect(() =>
        requireCheckIn({
          day: dayProjection(
            '2026-11-09',
            undefined,
            false,
            at('01:00:00.000'),
            record,
          ),
        } as Home),
      ).toThrow();
    },
  );

  it.each([
    ['COMPANY_HOLIDAY', 'ATTENDANCE_NOT_REQUIRED'],
    ['REST_DAY', 'ATTENDANCE_NOT_REQUIRED'],
    ['CHECK_IN_TOO_EARLY', 'CHECK_IN_TOO_EARLY'],
    ['SCHEDULE_NOT_CONFIGURED', 'SCHEDULE_NOT_CONFIGURED'],
  ])('maps check-in rejection %s to %s', (blockReason, code) => {
    try {
      requireCheckIn({
        day: { canCheckIn: false, attendance: null, blockReason },
      } as Home);
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ code });
    }
  });

  it.each([
    [0, 0],
    [1, 0],
    [999, 0],
    [1000, 1],
    [1999, 1],
    [2000, 2],
  ])('floors completed duration at %ims', (elapsed, seconds) => {
    const record = {
      version: 1,
      checkOutAt: null,
      checkInAt: at('01:00:00.000'),
    };
    expect(
      checkoutChanges(
        record,
        1,
        new Date(record.checkInAt.getTime() + elapsed),
      ),
    ).toMatchObject({ durationSeconds: seconds, version: 2 });
  });

  it('rejects stale version, a second checkout and backwards server time', () => {
    const record = {
      version: 2,
      checkInAt: at('01:00:00.000'),
      checkOutAt: null,
    };
    expect(() => checkoutChanges(record, 1, at('01:00:01.000'))).toThrow(
      'Version conflict',
    );
    expect(() =>
      checkoutChanges(
        { ...record, checkOutAt: at('01:00:01.000') },
        2,
        at('01:00:02.000'),
      ),
    ).toThrow('Already checked out');
    expect(() => checkoutChanges(record, 2, at('00:59:59.999'))).toThrow(
      'Server time precedes',
    );
  });
});
