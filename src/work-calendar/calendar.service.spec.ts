import type { EntityManager } from 'typeorm';

import { proposalFixture, scheduleFixture } from '../../test/calendar-fixture';
import { Clock } from '../runtime/clock';

import type { CalendarRepository } from './calendar.repository';
import { CalendarService } from './calendar.service';
import type { HolidayDate } from './calendar.types';
import { snapshotForDate } from './schedule.rules';

class TestClock extends Clock {
  value = new Date('2026-11-09T01:00:00.123Z');

  now() {
    return this.value;
  }
}

function setup() {
  const version = scheduleFixture();
  const repository = {
    timeline: jest.fn().mockResolvedValue([version]),
    holiday: jest.fn().mockResolvedValue(null),
  };
  const clock = new TestClock();
  const service = new CalendarService(
    repository as unknown as CalendarRepository,
    clock,
  );

  return { service, repository, clock, version };
}

describe('CalendarService decisions', () => {
  it('uses the injected clock for advisory preview and fresh save planning', () => {
    const { service, clock } = setup();
    const input = proposalFixture();

    expect(service.preview(input)).toEqual({
      activationMode: 'ON_SAVE',
      comparisonDate: '2026-11-09',
      effectiveAt: null,
    });
    expect(service.planSave(input, []).activateAt).toBe(
      '2026-11-09T01:00:00.123Z',
    );
    clock.value = new Date('2026-11-10T01:00:00Z');
    expect(() => service.planSave(input, [])).toThrow(
      expect.objectContaining({ code: 'PAST_DATE_IMMUTABLE' }),
    );
  });

  it('pins its observation instant before I/O and passes the supplied manager explicitly', async () => {
    const { service, repository, clock, version } = setup();
    const manager = {} as EntityManager;
    repository.timeline.mockImplementation(async () => {
      clock.value.setUTCFullYear(2025);
      return [version];
    });

    await expect(service.readAt(undefined, manager)).resolves.toMatchObject({
      current: { id: version.id },
    });
    expect(repository.timeline).toHaveBeenCalledWith(manager);
  });

  it.each([
    ['2026-11-09', 'WORKING_DAY', 1],
    ['2026-11-14', 'REST_DAY', 6],
    ['2026-11-15', 'REST_DAY', 7],
  ])('classifies %s as %s with ISO weekday %s', async (date, kind, weekday) => {
    const { service, repository } = setup();
    const day = await service.readDay(date);

    expect(day).toMatchObject({
      workDate: date,
      kind,
      isoWeekday: weekday,
      timeZone: 'Asia/Jakarta',
    });
    expect(day.schedule === null).toBe(kind !== 'WORKING_DAY');
    expect(Object.isFrozen(day)).toBe(true);
    expect(repository.holiday).toHaveBeenCalledWith(date, undefined);
  });

  it('checks the starting work date for overnight holiday/year boundaries', async () => {
    const { service, repository, version } = setup();
    repository.timeline.mockResolvedValue([
      { ...version, startTime: '22:00', endTime: '06:00', endDayOffset: 1 },
    ]);
    const holiday: HolidayDate = {
      date: '2027-01-01',
      name: 'New Year',
      category: 'PUBLIC',
    };
    repository.holiday.mockImplementation(async (date: string) =>
      date === holiday.date ? holiday : null,
    );
    const december = await service.readDay('2026-12-31');
    const january = await service.readDay('2027-01-01');

    expect(december.kind).toBe('WORKING_DAY');
    expect(december.schedule).toMatchObject({
      workDate: '2026-12-31',
      plannedEndAt: '2026-12-31T23:00:00.000Z',
    });
    expect(january).toMatchObject({ kind: 'HOLIDAY', schedule: null, holiday });
  });

  it('gives a dated holiday precedence over a rest day without resolving an unused DST interval', async () => {
    const { service, repository, version } = setup();
    repository.timeline.mockResolvedValue([
      { ...version, timeZone: 'America/New_York', startTime: '01:30' },
    ]);
    repository.holiday.mockResolvedValue({
      date: '2026-11-01',
      name: 'Holiday',
      category: 'COMPANY',
    });

    await expect(service.readDay('2026-11-01')).resolves.toMatchObject({
      kind: 'HOLIDAY',
      schedule: null,
    });
  });

  it('passes the same explicit transaction manager through both independent reads', async () => {
    const { service, repository } = setup();
    const manager = {} as EntityManager;

    await service.readDay('2026-11-09', manager);
    expect(repository.timeline).toHaveBeenCalledWith(manager);
    expect(repository.holiday).toHaveBeenCalledWith('2026-11-09', manager);
  });

  it('preserves a recorded snapshot without loading mutable calendar state', async () => {
    const { service, repository, version } = setup();
    const snapshot = snapshotForDate(version, '2026-11-09');

    await expect(service.readSnapshot('2026-11-09', snapshot)).resolves.toEqual(
      snapshot,
    );
    expect(repository.timeline).not.toHaveBeenCalled();
    expect(repository.holiday).not.toHaveBeenCalled();
  });

  it('rejects unconfigured dates and derives holiday cutoff from the active saved zone', async () => {
    const { service, repository, version } = setup();
    repository.timeline.mockResolvedValue([]);

    await expect(service.readDay('2026-11-09')).rejects.toMatchObject({
      code: 'SCHEDULE_NOT_CONFIGURED',
    });
    expect(service.holidayCutoff([version], '2026-11-08T16:30:00Z')).toBe(
      '2026-11-08',
    );
  });
});
