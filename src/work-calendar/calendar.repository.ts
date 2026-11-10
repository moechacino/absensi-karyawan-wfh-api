import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';

import { HolidayEntity, ScheduleVersionEntity } from '../database/entities';

import type { HolidayDate, SavedSchedule } from './calendar.types';

@Injectable()
export class CalendarRepository {
  constructor(private readonly source: DataSource) {}

  async timeline(
    manager: EntityManager = this.source.manager,
  ): Promise<readonly SavedSchedule[]> {
    const versions = await manager.find(ScheduleVersionEntity, {
      select: {
        id: true,
        workingDays: true,
        opensMinutesBeforeStart: true,
        startTime: true,
        endTime: true,
        endDayOffset: true,
        timeZone: true,
        effectiveFrom: true,
        effectiveAt: true,
        supersededAt: true,
      },
      order: { effectiveAt: 'ASC', id: 'ASC' },
    });

    return versions.map((version) => ({
      id: version.id,
      opensMinutesBeforeStart: version.opensMinutesBeforeStart ?? 15,
      workingDays: version.workingDays as number[],
      startTime: version.startTime,
      endTime: version.endTime,
      endDayOffset: version.endDayOffset as 0 | 1,
      timeZone: version.timeZone,
      effectiveFrom: version.effectiveFrom,
      effectiveAt: version.effectiveAt.toISOString(),
      supersededAt: version.supersededAt?.toISOString() ?? null,
    }));
  }

  async holiday(
    date: string,
    manager: EntityManager = this.source.manager,
  ): Promise<Readonly<HolidayDate> | null> {
    const row = await manager.findOne(HolidayEntity, {
      where: { year: Number(date.slice(0, 4)), date },
      select: { date: true, name: true, category: true },
    });

    return row
      ? Object.freeze({
          date: row.date,
          name: row.name,
          category: row.category,
        })
      : null;
  }
}
