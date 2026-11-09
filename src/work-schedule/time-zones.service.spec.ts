import { Clock } from '../runtime/clock';

import { TimeZonesService } from './time-zones.service';
import { scheduleCommand } from './schedule.command';

import { proposalFixture } from '../../test/calendar-fixture';

class TestClock extends Clock {
  now() {
    return new Date('2026-11-09T01:00:00Z');
  }
}

const zones = new TimeZonesService(new TestClock());

describe('TimeZonesService and canonical schedule inputs', () => {
  it('searches IANA IDs case-insensitively and uses a stable UTC reference date/instant', () => {
    expect(zones.list({ q: 'jAkArTa' })).toEqual({
      items: [
        {
          id: 'Asia/Jakarta',
          label: 'Asia/Jakarta (UTC+07:00)',
          offsetMinutes: 420,
          referenceAt: '2026-11-09T12:00:00.000Z',
        },
      ],
    });
    expect(
      zones.list({ q: 'Makassar', atDate: '2026-11-16' }).items[0],
    ).toMatchObject({ id: 'Asia/Makassar', offsetMinutes: 480 });
  });

  it('reports real seasonal offsets rather than using a constant UTC offset', () => {
    expect(
      zones.list({ q: 'New York', atDate: '2026-01-01' }).items[0]
        .offsetMinutes,
    ).toBe(-300);
    expect(
      zones.list({ q: 'New_York', atDate: '2026-07-01' }).items[0]
        .offsetMinutes,
    ).toBe(-240);
  });

  it('includes UTC before configuration and returns no arbitrary fallback for unknown search terms', () => {
    expect(zones.list({ q: 'UTC' }).items.map((item) => item.id)).toContain(
      'UTC',
    );
    expect(zones.list({ q: 'does-not-exist' })).toEqual({ items: [] });
  });

  it('does not invent rounded historical offsets that the public integer-minute DTO cannot represent', () => {
    for (const atDate of ['1900-01-01', '1970-01-01', '2026-11-09']) {
      const result = zones.list({ atDate });
      expect(result.items.length).toBeGreaterThan(0);
      expect(
        result.items.every(
          (item) =>
            Number.isInteger(item.offsetMinutes) &&
            Math.abs(item.offsetMinutes) <= 840,
        ),
      ).toBe(true);
      expect(result.items.map((item) => item.id)).toEqual(
        result.items.map((item) => item.id).toSorted(),
      );
    }
  });

  it('rejects invalid reference dates', () => {
    expect(() => zones.list({ atDate: '2026-02-30' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('canonicalizes weekday sets for receipts without mutating inputs or transport fields', () => {
    const input = proposalFixture({ workingDays: [5, 1, 3] });
    const result = scheduleCommand(input);

    expect(result).toEqual({ ...input, workingDays: [1, 3, 5] });
    expect(input.workingDays).toEqual([5, 1, 3]);
    expect(result).not.toHaveProperty('idempotencyKey');
  });
});
