import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { EntityManager } from 'typeorm';

import {
  CalendarStateEntity,
  HolidayCalendarEntity,
  HolidayEntity,
} from '../database/entities';
import type { HolidayCalendar } from '../attendance-rpc/rpc.responses';

import type { HolidayBatch } from './holiday.rules';

@Injectable()
export class HolidayRepository {
  constructor(private readonly source: DataSource) {}

  readConsistent<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.source.transaction('REPEATABLE READ', work);
  }

  lock(manager: EntityManager) {
    return manager.findOneOrFail(CalendarStateEntity, {
      where: { id: 1 },
      lock: { mode: 'pessimistic_write' },
    });
  }

  async calendar(
    year: number,
    manager: EntityManager,
  ): Promise<HolidayCalendar> {
    const [calendar, rows] = await Promise.all([
      manager.findOneBy(HolidayCalendarEntity, { year }),
      manager.find(HolidayEntity, {
        where: { year },
        select: { date: true, name: true, category: true },
        order: { date: 'ASC' },
      }),
    ]);

    return {
      year,
      version: calendar?.version ?? 0,
      items: rows.map(({ date, name, category }) => ({ date, name, category })),
    };
  }

  async apply(
    input: HolidayBatch,
    version: number,
    globalVersion: number,
    manager: EntityManager,
  ): Promise<void> {
    if (version === 1) {
      await manager.insert(HolidayCalendarEntity, {
        year: input.year,
        version,
      });
    } else {
      await manager.update(
        HolidayCalendarEntity,
        { year: input.year },
        { version },
      );
    }

    if (input.remove.length) {
      await manager.delete(HolidayEntity, {
        year: input.year,
        date: In([...input.remove]),
      });
    }

    if (input.upsert.length) {
      await manager.upsert(
        HolidayEntity,
        input.upsert.map(({ date, name, category }) => ({
          year: input.year,
          date,
          name,
          category,
        })),
        ['year', 'date'],
      );
    }

    await manager.update(
      CalendarStateEntity,
      { id: 1 },
      { version: globalVersion },
    );
  }
}
