import { proposalFixture, scheduleFixture } from '../../test/calendar-fixture';

import {
  recordedSnapshot,
  scheduleActivation,
  scheduleDefinition,
  snapshotForDate,
} from './schedule.rules';

describe('calendar schedule rules', () => {
  it.each(
    [[], [1, 1], [0, 1], [8], [1.5], [1, 2, 3, 4, 5, 6, 7, 1]].map(
      (workingDays) => [workingDays],
    ),
  )('rejects invalid ISO weekdays %j', (workingDays) => {
    expect(() => scheduleDefinition(scheduleFixture({ workingDays }))).toThrow(
      expect.objectContaining({ code: 'INVALID_WORKING_DAYS' }),
    );
  });

  it.each([
    { startTime: '08:00', endTime: '08:00', endDayOffset: 0 as const },
    { startTime: '08:00', endTime: '08:00', endDayOffset: 1 as const },
    { startTime: '16:00', endTime: '08:00', endDayOffset: 0 as const },
    { startTime: '08:00', endTime: '09:00', endDayOffset: 1 as const },
  ])('rejects nonpositive/24h-or-longer local intervals %j', (interval) => {
    expect(() => scheduleDefinition(scheduleFixture(interval))).toThrow(
      expect.objectContaining({ code: 'INVALID_DURATION' }),
    );
  });

  it('returns a detached, frozen definition without mutating caller weekdays', () => {
    const weekdays = [5, 1];
    const input = scheduleFixture({ workingDays: weekdays });
    const definition = scheduleDefinition(input);
    weekdays.push(2);

    expect(definition.workingDays).toEqual([5, 1]);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.workingDays)).toBe(true);
    expect(definition).not.toHaveProperty('id');
  });

  it('compares today in the selected new zone, with ON_SAVE effectiveAt null', () => {
    const at = '2026-11-08T16:30:00.123Z';
    const jakarta = scheduleActivation(
      proposalFixture({ effectiveFrom: '2026-11-08' }),
      at,
    );
    const makassar = scheduleActivation(
      proposalFixture({
        timeZone: 'Asia/Makassar',
        effectiveFrom: '2026-11-09',
      }),
      at,
    );

    expect(jakarta).toEqual({
      comparisonDate: '2026-11-08',
      activationMode: 'ON_SAVE',
      effectiveAt: null,
    });
    expect(makassar).toEqual({
      comparisonDate: '2026-11-09',
      activationMode: 'ON_SAVE',
      effectiveAt: null,
    });
    expect(() =>
      scheduleActivation(
        proposalFixture({
          timeZone: 'Asia/Makassar',
          effectiveFrom: '2026-11-08',
        }),
        at,
      ),
    ).toThrow(expect.objectContaining({ code: 'PAST_DATE_IMMUTABLE' }));
  });

  it('resolves a future activation at strict midnight in its new zone', () => {
    expect(
      scheduleActivation(
        proposalFixture({
          timeZone: 'Asia/Makassar',
          effectiveFrom: '2026-11-16',
        }),
        '2026-11-09T01:00:00Z',
      ),
    ).toEqual({
      comparisonDate: '2026-11-09',
      activationMode: 'AT_INSTANT',
      effectiveAt: '2026-11-15T16:00:00.000Z',
    });
    expect(() =>
      scheduleActivation(
        proposalFixture({
          timeZone: 'America/Sao_Paulo',
          effectiveFrom: '2018-11-04',
        }),
        '2018-11-03T12:00:00Z',
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_LOCAL_TIME' }));
  });

  it('assigns an overnight shift to its starting date across December–January', () => {
    const version = scheduleFixture({
      startTime: '22:00',
      endTime: '06:00',
      endDayOffset: 1,
    });

    expect(snapshotForDate(version, '2026-12-31')).toEqual({
      scheduleVersionId: version.id,
      workDate: '2026-12-31',
      timeZone: 'Asia/Jakarta',
      plannedStartAt: '2026-12-31T15:00:00.000Z',
      plannedEndAt: '2026-12-31T23:00:00.000Z',
    });
  });

  it('uses actual zone offsets across DST while validating nominal local duration', () => {
    const version = scheduleFixture({
      timeZone: 'America/New_York',
      startTime: '00:00',
      endTime: '04:00',
    });
    const spring = snapshotForDate(version, '2026-03-08');
    const autumn = snapshotForDate(version, '2026-11-01');

    expect(
      Date.parse(spring.plannedEndAt) - Date.parse(spring.plannedStartAt),
    ).toBe(3 * 3600000);
    expect(
      Date.parse(autumn.plannedEndAt) - Date.parse(autumn.plannedStartAt),
    ).toBe(5 * 3600000);
    expect(() =>
      snapshotForDate({ ...version, startTime: '01:30' }, '2026-11-01'),
    ).toThrow(expect.objectContaining({ code: 'INVALID_LOCAL_TIME' }));
  });

  it('applies the below-24h limit to local wall time rather than DST elapsed hours', () => {
    const version = scheduleFixture({
      timeZone: 'America/New_York',
      startTime: '00:00',
      endTime: '23:30',
    });
    const snapshot = snapshotForDate(version, '2026-11-01');

    expect(
      Date.parse(snapshot.plannedEndAt) - Date.parse(snapshot.plannedStartAt),
    ).toBe(24.5 * 3600000);
  });

  it('preserves an open attendance snapshot verbatim after schedule/zone changes', () => {
    const old = snapshotForDate(
      scheduleFixture({
        startTime: '22:00',
        endTime: '06:00',
        endDayOffset: 1,
      }),
      '2026-12-31',
    );
    const preserved = recordedSnapshot('2026-12-31', old);

    expect(preserved).toEqual(old);
    expect(preserved).not.toBe(old);
    expect(Object.isFrozen(preserved)).toBe(true);
    expect(() => recordedSnapshot('2027-01-01', old)).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });
});
