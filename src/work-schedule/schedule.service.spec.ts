import type { EntityManager } from 'typeorm';

import { proposalFixture } from '../../test/calendar-fixture';
import type { ScheduleVersionEntity } from '../database/entities';
import { CalendarService } from '../work-calendar/calendar.service';
import type { CalendarRepository } from '../work-calendar/calendar.repository';
import { Clock } from '../runtime/clock';

import { ScheduleService } from './schedule.service';
import type { ScheduleRepository } from './schedule.repository';

class TestClock extends Clock {
  value = new Date('2026-11-09T01:00:00.123Z');

  now() {
    return new Date(this.value);
  }
}

function row(
  extra: Partial<ScheduleVersionEntity> = {},
): ScheduleVersionEntity {
  return {
    id: '00000007-1111-4111-8111-000000000007',
    createdBy: '00000001-1111-4111-8111-000000000001',
    actor: {
      id: '00000001-1111-4111-8111-000000000001',
      fullName: 'Schedule author',
      initialPassword: 'never-return-this',
    },
    createdAt: new Date('2026-11-01T00:00:00Z'),
    workingDays: [1, 2, 3, 4, 5],
    startTime: '08:00',
    endTime: '16:00',
    endDayOffset: 0,
    timeZone: 'Asia/Jakarta',
    effectiveFrom: '2026-11-01',
    effectiveAt: new Date('2026-10-31T17:00:00Z'),
    supersededAt: null,
    ...extra,
  } as ScheduleVersionEntity;
}

function setup() {
  const manager = {} as EntityManager;
  const clock = new TestClock();
  const repository = {
    readConsistent: jest.fn(
      (work: (manager: EntityManager) => Promise<unknown>) => work(manager),
    ),
    state: jest.fn().mockResolvedValue({ id: 1, version: 0 }),
    currentState: jest.fn().mockResolvedValue({ id: 1, version: 0 }),
    versions: jest.fn().mockResolvedValue([]),
    history: jest.fn().mockResolvedValue([[], 0]),
    insert: jest.fn().mockResolvedValue(undefined),
    supersede: jest.fn().mockResolvedValue(undefined),
    advanceVersion: jest.fn().mockResolvedValue(undefined),
    appendEvents: jest.fn().mockResolvedValue(undefined),
    version: jest
      .fn()
      .mockImplementation(async (id: string) =>
        row({ ...repository.insert.mock.calls[0][0], id }),
      ),
  };
  const calendar = new CalendarService({} as CalendarRepository, clock);
  const service = new ScheduleService(
    repository as unknown as ScheduleRepository,
    calendar,
    clock,
  );

  return { service, repository, clock, manager };
}

describe('ScheduleService', () => {
  it('returns the unconfigured global resource without inventing a default schedule', async () => {
    const { service } = setup();

    await expect(service.get()).resolves.toEqual({
      version: 0,
      current: null,
      upcoming: null,
      checkInPolicy: { opensMinutesBeforeStart: 15, lateAfterMinutes: 0 },
    });
  });

  it('maps active/upcoming public DTOs without credential fields', async () => {
    const { service, repository } = setup();
    repository.versions.mockResolvedValue([
      row(),
      row({
        id: 'pending',
        effectiveAt: new Date('2026-11-15T16:00:00Z'),
        effectiveFrom: '2026-11-16',
        timeZone: 'Asia/Makassar',
      }),
    ]);
    const result = await service.get();

    expect(result.current).toMatchObject({
      id: row().id,
      state: 'ACTIVE',
      createdBy: { id: row().createdBy, fullName: 'Schedule author' },
    });
    expect(result.upcoming).toMatchObject({
      id: 'pending',
      state: 'SCHEDULED',
    });
    expect(JSON.stringify(result)).not.toContain('never-return-this');
    expect(result.current).not.toHaveProperty('supersededAt');
  });

  it('previews valid input without writes, locks or reservations', async () => {
    const { service, repository } = setup();
    const result = await service.preview(proposalFixture());

    expect(result).toMatchObject({
      comparisonDate: '2026-11-09',
      activationMode: 'ON_SAVE',
      effectiveAt: null,
      impact: { canApply: true, issues: [] },
    });
    expect(repository.readConsistent).not.toHaveBeenCalled();
    expect(repository.insert).not.toHaveBeenCalled();
    expect(repository.state).not.toHaveBeenCalled();
  });

  it('reports stale preview versions as a safe advisory issue', async () => {
    const { service, repository } = setup();
    repository.currentState.mockResolvedValue({ id: 1, version: 2 });

    await expect(service.preview(proposalFixture())).resolves.toMatchObject({
      impact: {
        canApply: false,
        issues: [{ code: 'VERSION_CONFLICT', field: 'expectedVersion' }],
      },
    });
  });

  it.each([
    [{ endTime: '08:00' }, 'INVALID_DURATION'],
    [{ effectiveFrom: '2026-11-08' }, 'PAST_DATE_IMMUTABLE'],
    [{ timeZone: 'Unsupported/Zone' }, 'TIME_ZONE_INVALID'],
  ] as const)(
    'rejects a proposal with no valid activation instead of fabricating preview fields',
    async (input, code) => {
      const { service, repository } = setup();

      await expect(
        service.preview(proposalFixture(input)),
      ).rejects.toMatchObject({ code });
      expect(repository.currentState).not.toHaveBeenCalled();
    },
  );

  it('saves today only through the supplied transaction manager and records one version/event', async () => {
    const { service, repository, manager } = setup();
    const result = await service.change(
      proposalFixture(),
      row().createdBy,
      manager,
    );

    expect(repository.state).toHaveBeenCalledWith(manager, true);
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveAt: new Date('2026-11-09T01:00:00.123Z'),
        createdBy: row().createdBy,
      }),
      manager,
    );
    expect(repository.advanceVersion).toHaveBeenCalledWith(1, manager);
    expect(repository.appendEvents).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: 'SAVED', calendarVersion: 1 })],
      manager,
    );
    expect(result.schedule).toMatchObject({
      version: 1,
      current: { state: 'ACTIVE' },
      upcoming: null,
    });
    expect(repository.readConsistent).not.toHaveBeenCalled();
  });

  it('replaces a pending version at save time while keeping current coverage for a later activation', async () => {
    const { service, repository, manager } = setup();
    const old = row();
    const pending = row({
      id: 'pending',
      effectiveAt: new Date('2026-11-15T16:00:00Z'),
      effectiveFrom: '2026-11-16',
      timeZone: 'Asia/Makassar',
    });
    repository.versions.mockResolvedValue([old, pending]);
    const result = await service.change(
      proposalFixture({ effectiveFrom: '2026-11-20' }),
      old.createdBy,
      manager,
    );

    expect(repository.supersede).toHaveBeenCalledWith(
      ['pending'],
      new Date('2026-11-09T01:00:00.123Z'),
      manager,
    );
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveAt: new Date('2026-11-19T17:00:00Z'),
      }),
      manager,
    );
    expect(result.schedule.current?.id).toBe(old.id);
    expect(result.schedule.upcoming?.effectiveFrom).toBe('2026-11-20');
    expect(pending.supersededAt).toBeNull();
  });

  it('closes current plus pending for an immediate replacement and appends both events', async () => {
    const { service, repository, manager } = setup();
    const old = row();
    const pending = row({
      id: 'pending',
      effectiveAt: new Date('2026-11-15T17:00:00Z'),
    });
    repository.versions.mockResolvedValue([old, pending]);
    await service.change(proposalFixture(), old.createdBy, manager);

    expect(repository.supersede).toHaveBeenCalledWith(
      ['pending', old.id],
      new Date('2026-11-09T01:00:00.123Z'),
      manager,
    );
    expect(
      repository.appendEvents.mock.calls[0][0].map(
        (event: { kind: string }) => event.kind,
      ),
    ).toEqual(['SAVED', 'SUPERSEDED', 'SUPERSEDED']);
  });

  it('rejects stale saves before insert/version/event writes', async () => {
    const { service, repository, manager } = setup();
    repository.state.mockResolvedValue({ id: 1, version: 2 });

    await expect(
      service.change(proposalFixture(), row().createdBy, manager),
    ).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      publicOptions: { details: { expectedVersion: 0, actualVersion: 2 } },
    });
    expect(repository.insert).not.toHaveBeenCalled();
    expect(repository.appendEvents).not.toHaveBeenCalled();
  });

  it('recomputes dates after waiting for the calendar lock, even after a successful preview', async () => {
    const { service, repository, clock, manager } = setup();
    await service.preview(proposalFixture());
    repository.state.mockImplementation(async () => {
      clock.value = new Date('2026-11-10T01:00:00Z');
      return { id: 1, version: 0 };
    });

    await expect(
      service.change(proposalFixture(), row().createdBy, manager),
    ).rejects.toMatchObject({ code: 'PAST_DATE_IMMUTABLE' });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('propagates an event persistence failure to the owning command transaction', async () => {
    const { service, repository, manager } = setup();
    const failure = new Error('event write failed');
    repository.appendEvents.mockRejectedValue(failure);

    await expect(
      service.change(proposalFixture(), row().createdBy, manager),
    ).rejects.toBe(failure);
    expect(repository.version).toHaveBeenCalledWith(
      expect.any(String),
      manager,
    );
  });

  it('starts event persistence and the response lookup independently after dependent writes', async () => {
    const { service, repository, manager } = setup();
    let finishEvents!: () => void;
    let lookupStarted!: () => void;
    const eventGate = new Promise<void>((resolve) => {
      finishEvents = resolve;
    });
    const lookupGate = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    const original = repository.version.getMockImplementation()!;
    repository.appendEvents.mockReturnValue(eventGate);
    repository.version.mockImplementation(async (id: string) => {
      lookupStarted();
      return original(id);
    });
    const pending = service.change(proposalFixture(), row().createdBy, manager);
    await lookupGate;

    expect(repository.advanceVersion).toHaveBeenCalled();
    expect(repository.appendEvents).toHaveBeenCalled();
    finishEvents();
    await expect(pending).resolves.toMatchObject({ schedule: { version: 1 } });
  });

  it('maps paginated historical states from the same consistent view', async () => {
    const { service, repository, manager } = setup();
    const old = row();
    const canceled = row({
      id: 'canceled',
      effectiveAt: new Date('2026-11-20T17:00:00Z'),
      supersededAt: new Date('2026-11-08T01:00:00Z'),
    });
    repository.versions.mockResolvedValue([old, canceled]);
    repository.history.mockResolvedValue([[canceled, old], 2]);
    const result = await service.history({ page: 2, pageSize: 2 });

    expect(result.items.map((item) => item.state)).toEqual([
      'SUPERSEDED',
      'ACTIVE',
    ]);
    expect(result.pagination).toEqual({
      page: 2,
      pageSize: 2,
      totalItems: 2,
      totalPages: 1,
    });
    expect(repository.history).toHaveBeenCalledWith(2, 2, manager);
  });
});
