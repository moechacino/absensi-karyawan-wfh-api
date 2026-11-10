import { proposalFixture, scheduleFixture } from '../../test/calendar-fixture';

import {
  holidayCutoff,
  planScheduleSave,
  savedTimeline,
  scheduleForDate,
  scheduleSnapshot,
  timelineAt,
} from './schedule.timeline';

const current = () => scheduleFixture();

const pending = () =>
  scheduleFixture({
    id: '00000008-1111-4111-8111-000000000008',
    effectiveFrom: '2026-11-16',
    effectiveAt: '2026-11-15T16:00:00.000Z',
    timeZone: 'Asia/Makassar',
  });

describe('one saved global schedule timeline', () => {
  it('resolves current/upcoming by saved instant without a cron or a read mutation', () => {
    const versions = [pending(), current()];
    const original = JSON.stringify(versions);

    expect(timelineAt(versions, '2026-11-15T15:59:59.999Z')).toMatchObject({
      current: { id: current().id },
      upcoming: { id: pending().id },
    });
    expect(timelineAt(versions, '2026-11-15T16:00:00.000Z')).toMatchObject({
      current: { id: pending().id },
      upcoming: null,
    });
    expect(JSON.stringify(versions)).toBe(original);
  });

  it('does not activate the first future version early or extrapolate before first coverage', () => {
    expect(timelineAt([pending()], '2026-11-09T01:00:00Z')).toMatchObject({
      current: null,
      upcoming: { id: pending().id },
    });
    expect(() => scheduleForDate([pending()], '2026-11-15')).toThrow(
      expect.objectContaining({ code: 'SCHEDULE_NOT_CONFIGURED' }),
    );
    expect(() => scheduleForDate([], '2026-11-16')).toThrow(
      expect.objectContaining({ code: 'SCHEDULE_NOT_CONFIGURED' }),
    );
    expect(scheduleForDate([pending()], '2026-11-16').id).toBe(pending().id);
  });

  it('replaces exactly the pending version and pins ON_SAVE to the supplied save instant', () => {
    const at = '2026-11-09T01:00:00.123Z';
    const versions = [current(), pending()];
    const plan = planScheduleSave(proposalFixture(), versions, at);

    expect(plan).toEqual({
      comparisonDate: '2026-11-09',
      activationMode: 'ON_SAVE',
      effectiveAt: null,
      saveAt: at,
      activateAt: at,
      closeCurrentId: current().id,
      replacePendingIds: [pending().id],
    });
    expect(Object.isFrozen(plan.replacePendingIds)).toBe(true);
    expect(
      planScheduleSave(
        proposalFixture({ effectiveFrom: '2026-11-20' }),
        versions,
        at,
      ),
    ).toMatchObject({
      saveAt: at,
      activateAt: '2026-11-19T17:00:00.000Z',
      replacePendingIds: [pending().id],
    });
  });

  it('excludes a canceled future version while retaining older historical coverage', () => {
    const canceled = { ...pending(), supersededAt: '2026-11-10T01:00:00.000Z' };
    const replacement = {
      ...pending(),
      id: 'replacement',
      effectiveFrom: '2026-11-20',
      effectiveAt: '2026-11-19T16:00:00.000Z',
    };
    const versions = [current(), canceled, replacement];

    expect(savedTimeline(versions).map((version) => version.id)).toEqual([
      current().id,
      replacement.id,
    ]);
    expect(scheduleForDate(versions, '2026-11-18').id).toBe(current().id);
    expect(scheduleForDate(versions, '2026-11-20').id).toBe(replacement.id);
    expect(scheduleForDate(versions, '2026-11-02').id).toBe(current().id);
  });

  it('uses the latest applicable activation date for an unrecorded ON_SAVE day', () => {
    const replacement = {
      ...pending(),
      effectiveFrom: '2026-11-09',
      effectiveAt: '2026-11-09T05:00:00.000Z',
    };

    expect(scheduleForDate([current(), replacement], '2026-11-09').id).toBe(
      replacement.id,
    );
    expect(scheduleForDate([current(), replacement], '2026-11-08').id).toBe(
      current().id,
    );
  });

  it('rejects missing coverage after an explicitly closed timeline interval', () => {
    const closed = { ...current(), supersededAt: '2026-11-09T17:00:00.000Z' };

    expect(scheduleForDate([closed], '2026-11-09').id).toBe(closed.id);
    expect(() => scheduleForDate([closed], '2026-11-10')).toThrow(
      expect.objectContaining({ code: 'SCHEDULE_NOT_CONFIGURED' }),
    );
    expect(timelineAt([closed], '2026-11-09T17:00:00.000Z').current).toBeNull();
  });

  it('does not resurrect an older version across a closed interval and can read historical future activations', () => {
    const old = current();
    const closed = { ...pending(), supersededAt: '2026-11-17T00:00:00Z' };
    const later = {
      ...pending(),
      id: 'later',
      effectiveFrom: '2026-11-20',
      effectiveAt: '2026-11-19T16:00:00Z',
    };

    expect(
      timelineAt([old, closed, later], '2026-11-18T00:00:00Z'),
    ).toMatchObject({ current: null, upcoming: { id: 'later' } });
    expect(
      timelineAt([old, closed, later], '2026-11-09T00:00:00Z'),
    ).toMatchObject({ current: { id: old.id }, upcoming: { id: closed.id } });
  });

  it('refuses inconsistent same-instant or multiple-pending timelines', () => {
    expect(() =>
      savedTimeline([current(), { ...current(), id: 'duplicate' }]),
    ).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
    expect(() =>
      planScheduleSave(
        proposalFixture(),
        [
          pending(),
          { ...pending(), id: 'another', effectiveAt: '2026-11-16T16:00:00Z' },
        ],
        '2026-11-09T01:00:00Z',
      ),
    ).toThrow(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
  });

  it('uses the active zone, not a selected/pending zone, for holiday cutoff', () => {
    const versions = [current(), pending()];

    expect(holidayCutoff(versions, '2026-11-08T16:30:00Z')).toBe('2026-11-08');
    expect(holidayCutoff(versions, '2026-11-15T16:30:00Z')).toBe('2026-11-16');
    expect(() => holidayCutoff([pending()], '2026-11-08T16:30:00Z')).toThrow(
      expect.objectContaining({ code: 'SCHEDULE_NOT_CONFIGURED' }),
    );
  });

  it('returns recorded snapshots before touching current or missing timeline coverage', () => {
    const snapshot = {
      opensMinutesBeforeStart: 15,
      scheduleVersionId: current().id,
      workDate: '2026-12-31',
      timeZone: 'Asia/Jakarta',
      plannedStartAt: '2026-12-31T15:00:00.000Z',
      plannedEndAt: '2026-12-31T23:00:00.000Z',
    };

    expect(scheduleSnapshot([], '2026-12-31', snapshot)).toEqual(snapshot);
    expect(
      scheduleSnapshot(
        [{ ...pending(), timeZone: 'Unsupported/Zone' }],
        '2026-12-31',
        snapshot,
      ),
    ).toEqual(snapshot);
  });
});
