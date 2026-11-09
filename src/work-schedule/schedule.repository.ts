import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { EntityManager, FindManyOptions } from 'typeorm';

import {
  CalendarStateEntity,
  ScheduleVersionEntity,
  ScheduleEventEntity,
} from '../database/entities';

type NewSchedule = Omit<
  Partial<ScheduleVersionEntity>,
  'workingDays' | 'actor'
> & { workingDays: number[] };
type NewScheduleEvent = Omit<Partial<ScheduleEventEntity>, 'details'> & {
  details: Record<string, string>;
};

const viewOptions: FindManyOptions<ScheduleVersionEntity> = {
  select: {
    id: true,
    createdAt: true,
    workingDays: true,
    startTime: true,
    endTime: true,
    endDayOffset: true,
    timeZone: true,
    effectiveFrom: true,
    effectiveAt: true,
    supersededAt: true,
    createdBy: true,
    actor: { id: true, fullName: true },
  },
  relations: { actor: true },
  relationLoadStrategy: 'join',
  order: { effectiveAt: 'ASC', id: 'ASC' },
};

@Injectable()
export class ScheduleRepository {
  constructor(private readonly source: DataSource) {}

  readConsistent<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.source.transaction('REPEATABLE READ', work);
  }

  state(manager: EntityManager, lock = false) {
    return manager.findOneOrFail(CalendarStateEntity, {
      where: { id: 1 },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
  }

  currentState() {
    return this.state(this.source.manager);
  }

  versions(manager: EntityManager) {
    return manager.find(ScheduleVersionEntity, viewOptions);
  }

  version(id: string, manager: EntityManager) {
    return manager.findOneOrFail(ScheduleVersionEntity, {
      ...viewOptions,
      where: { id },
    });
  }

  history(page: number, pageSize: number, manager: EntityManager) {
    return Promise.all([
      manager.find(ScheduleVersionEntity, {
        ...viewOptions,
        order: { effectiveAt: 'DESC', id: 'ASC' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      manager.count(ScheduleVersionEntity),
    ]);
  }

  async insert(row: NewSchedule, manager: EntityManager): Promise<void> {
    await manager.insert(ScheduleVersionEntity, row);
  }

  async supersede(
    ids: string[],
    at: Date,
    manager: EntityManager,
  ): Promise<void> {
    if (ids.length) {
      await manager.update(
        ScheduleVersionEntity,
        { id: In(ids) },
        { supersededAt: at },
      );
    }
  }

  async advanceVersion(version: number, manager: EntityManager): Promise<void> {
    await manager.update(CalendarStateEntity, { id: 1 }, { version });
  }

  async appendEvents(
    events: NewScheduleEvent[],
    manager: EntityManager,
  ): Promise<void> {
    await manager.insert(ScheduleEventEntity, events);
  }
}
