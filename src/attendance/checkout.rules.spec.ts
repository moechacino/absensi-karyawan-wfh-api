import { scheduleFixture } from '../../test/calendar-fixture';
import { checkoutDeadline, checkoutTiming } from './checkout.rules';

const version = scheduleFixture();

describe('checkout policy', () => {
  it('closes at the next check-in opening, rather than the planned end or midnight', () => {
    expect(checkoutDeadline([version], '2026-11-09', [])).toBe(
      '2026-11-10T00:45:00.000Z',
    );
  });

  it('skips rest days, company holidays, and year boundaries', () => {
    expect(checkoutDeadline([version], '2026-12-31', ['2027-01-01'])).toBe(
      '2027-01-04T00:45:00.000Z',
    );
  });

  it('allows a 20:00–04:00 shift to check out after 04:00 until the following 19:45', () => {
    expect(
      checkoutDeadline(
        [{ ...version, startTime: '20:00', endTime: '04:00', endDayOffset: 1 }],
        '2026-11-09',
        [],
      ),
    ).toBe('2026-11-10T12:45:00.000Z');
  });

  it('uses the new shift timezone, start and allowance after a future schedule change', () => {
    const next = {
      ...version,
      id: 'next',
      effectiveFrom: '2026-11-10',
      effectiveAt: '2026-11-09T16:00:00.000Z',
      timeZone: 'Asia/Makassar',
      startTime: '09:00',
      endTime: '17:00',
      opensMinutesBeforeStart: 30,
    };
    expect(checkoutDeadline([version, next], '2026-11-09', [])).toBe(
      '2026-11-10T00:30:00.000Z',
    );
  });

  it('skips a next shift whose local start cannot open during a DST gap', () => {
    const ny = {
      ...version,
      workingDays: [1, 2, 3, 4, 5, 6, 7],
      effectiveFrom: '2026-01-01',
      effectiveAt: '2026-01-01T05:00:00.000Z',
      timeZone: 'America/New_York',
      startTime: '02:30',
      endTime: '10:30',
    };
    expect(checkoutDeadline([ny], '2026-03-07', [])).toBe(
      '2026-03-09T06:15:00.000Z',
    );
  });

  it('does not invent a next shift without schedule coverage', () => {
    expect(checkoutDeadline([], '2026-11-09', [])).toBeNull();
  });

  it.each([
    ['2026-11-09T08:59:59.999Z', 'EARLY', 1],
    ['2026-11-09T08:59:58.001Z', 'EARLY', 1],
    ['2026-11-09T09:00:00.000Z', 'ON_TIME', 0],
    ['2026-11-09T09:05:00.000Z', 'LATE', 0],
    ['2026-11-09T18:00:00.000Z', 'LATE', 0],
  ])('classifies checkout at %s as %s', (at, state, seconds) => {
    expect(
      checkoutTiming(new Date(at), new Date('2026-11-09T09:00:00Z')),
    ).toEqual({ checkOutPunctuality: state, earlyCheckOutSeconds: seconds });
  });

  it('does not report an early departure for an absent checkout', () => {
    expect(checkoutTiming(null, new Date())).toEqual({
      checkOutPunctuality: null,
      earlyCheckOutSeconds: null,
    });
  });
});
