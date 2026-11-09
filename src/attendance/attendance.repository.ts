import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { EntityManager } from 'typeorm';
import {
  AttendanceEntity,
  CalendarStateEntity,
  EmployeeEntity,
  HolidayEntity,
} from '../database/entities';

@Injectable()
export class AttendanceRepository {
  constructor(private readonly source: DataSource) {}

  readConsistent<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.source.transaction('REPEATABLE READ', work);
  }

  calendar(manager: EntityManager, lock = false): Promise<CalendarStateEntity> {
    return manager.findOneOrFail(CalendarStateEntity, {
      where: { id: 1 },
      ...(lock ? { lock: { mode: 'pessimistic_read' as const } } : {}),
    });
  }

  async lockEmployee(id: string, manager: EntityManager): Promise<void> {
    await manager.findOneOrFail(EmployeeEntity, {
      where: { id },
      select: { id: true },
      lock: { mode: 'pessimistic_write' },
    });
  }

  records(
    employeeId: string,
    dates: string[],
    manager: EntityManager,
  ): Promise<AttendanceEntity[]> {
    return manager.find(AttendanceEntity, {
      where: [
        { employeeId, openEmployeeId: employeeId },
        ...(dates.length ? [{ employeeId, workDate: In(dates) }] : []),
      ],
      relations: { photo: true },
      relationLoadStrategy: 'join',
    });
  }

  holidays(dates: string[], manager: EntityManager): Promise<HolidayEntity[]> {
    if (!dates.length) {
      return Promise.resolve([]);
    }

    return manager.find(HolidayEntity, {
      where: dates.map((date) => ({ year: Number(date.slice(0, 4)), date })),
      select: { date: true },
    });
  }

  owned(id: string, employeeId: string): Promise<boolean> {
    return this.source.manager.existsBy(AttendanceEntity, { id, employeeId });
  }

  get(id: string, manager: EntityManager): Promise<AttendanceEntity> {
    return manager.findOneOrFail(AttendanceEntity, {
      where: { id },
      relations: { photo: true },
      relationLoadStrategy: 'join',
      lock: { mode: 'pessimistic_write' },
    });
  }

  async insert(row: AttendanceEntity, manager: EntityManager): Promise<void> {
    await manager.insert(AttendanceEntity, row);
  }

  async close(
    id: string,
    changes: { checkOutAt: Date; durationSeconds: number; version: number },
    manager: EntityManager,
  ): Promise<void> {
    await manager.update(AttendanceEntity, { id }, changes);
  }
}
