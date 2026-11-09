import type { EntityManager } from 'typeorm';

import { CalendarService } from '../work-calendar/calendar.service';
import { CalendarRepository } from '../work-calendar/calendar.repository';
import { Clock } from '../runtime/clock';
import { ProblemException } from '../http/problem';

import { HolidayRepository } from './holiday.repository';
import { HolidayService } from './holiday.service';

function fixture() {
  const manager = {} as EntityManager;
  const resource = { year: 2026, version: 0, items: [] };
  const repository = {
    readConsistent: jest.fn(
      (work: (manager: EntityManager) => Promise<unknown>) => work(manager),
    ),
    calendar: jest.fn().mockResolvedValue(resource),
    lock: jest.fn().mockResolvedValue({ version: 7 }),
    apply: jest.fn().mockResolvedValue(undefined),
  };
  const timelines = { timeline: jest.fn().mockResolvedValue([]) };
  const calendar = { holidayCutoff: jest.fn().mockReturnValue('2026-11-09') };
  const clock = {
    now: jest.fn().mockReturnValue(new Date('2026-11-09T01:00:00Z')),
  };
  const service = new HolidayService(
    repository as unknown as HolidayRepository,
    calendar as unknown as CalendarService,
    timelines as unknown as CalendarRepository,
    clock as Clock,
  );
  const input = {
    year: 2026,
    expectedVersion: 0,
    upsert: [{ date: '2026-11-09', name: 'Day', category: 'COMPANY' as const }],
    remove: [],
  };

  return {
    service,
    repository,
    timelines,
    calendar,
    clock,
    manager,
    input,
    resource,
  };
}

describe('HolidayService', () => {
  it('reads the annual resource in a consistent snapshot', async () => {
    const f = fixture();
    expect(await f.service.get(2026)).toEqual(f.resource);
    expect(f.repository.calendar).toHaveBeenCalledWith(2026, f.manager);
  });

  it('previews without writes or locks, reporting stale versions', async () => {
    const f = fixture();
    expect(
      await f.service.preview({ ...f.input, expectedVersion: 1 }),
    ).toMatchObject({
      canApply: false,
      issues: [{ code: 'VERSION_CONFLICT' }],
    });
    expect(f.repository.lock).not.toHaveBeenCalled();
    expect(f.repository.apply).not.toHaveBeenCalled();
  });

  it('locks before capturing time, then advances annual and global versions', async () => {
    const f = fixture();
    f.repository.lock.mockImplementation(async () => {
      expect(f.clock.now).not.toHaveBeenCalled();
      f.clock.now.mockReturnValue(new Date('2026-11-09T17:00:00Z'));
      return { version: 7 };
    });
    await f.service.change(f.input, f.manager);
    expect(f.calendar.holidayCutoff).toHaveBeenCalledWith(
      [],
      new Date('2026-11-09T17:00:00Z'),
    );
    expect(f.repository.apply).toHaveBeenCalledWith(f.input, 1, 8, f.manager);
    expect(f.repository.calendar).toHaveBeenCalledTimes(2);
  });

  it.each([
    [1, '2026-11-09', 'VERSION_CONFLICT', 409],
    [0, '2026-11-10', 'PAST_DATE_IMMUTABLE', 422],
  ])(
    'rejects invalid changes without persistence',
    async (expectedVersion, cutoff, code, status) => {
      const f = fixture();
      f.calendar.holidayCutoff.mockReturnValue(cutoff);
      await expect(
        f.service.change({ ...f.input, expectedVersion }, f.manager),
      ).rejects.toMatchObject({ code, status });
      expect(f.repository.apply).not.toHaveBeenCalled();
    },
  );

  it('requires a currently active schedule for both preview and save', async () => {
    const f = fixture();
    f.calendar.holidayCutoff.mockImplementation(() => {
      throw new ProblemException(409, 'SCHEDULE_NOT_CONFIGURED', 'No schedule');
    });
    await expect(f.service.preview(f.input)).rejects.toMatchObject({
      code: 'SCHEDULE_NOT_CONFIGURED',
    });
    await expect(f.service.change(f.input, f.manager)).rejects.toMatchObject({
      code: 'SCHEDULE_NOT_CONFIGURED',
    });
    expect(f.repository.apply).not.toHaveBeenCalled();
  });

  it('propagates persistence failures for transaction rollback', async () => {
    const f = fixture();
    f.repository.apply.mockRejectedValue(new Error('write failure'));
    await expect(f.service.change(f.input, f.manager)).rejects.toThrow(
      'write failure',
    );
    expect(f.repository.calendar).toHaveBeenCalledTimes(1);
  });
});
