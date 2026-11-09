import { Injectable } from '@nestjs/common';
import { Between, DataSource, In } from 'typeorm';
import type { EntityManager } from 'typeorm';
import {
  AttendanceEntity,
  EmployeeEntity,
  HolidayEntity,
} from '../database/entities';

@Injectable()
export class AttendanceReadRepository {
  constructor(private readonly source: DataSource) {}

  consistent<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.source.transaction('REPEATABLE READ', work);
  }

  employee(id: string, manager: EntityManager): Promise<EmployeeEntity | null> {
    return manager.findOne(EmployeeEntity, {
      where: { id },
      select: { id: true, createdAt: true },
    });
  }

  holidays(
    from: string,
    to: string,
    manager: EntityManager,
  ): Promise<HolidayEntity[]> {
    return manager.find(HolidayEntity, {
      where: {
        year: Between(Number(from.slice(0, 4)), Number(to.slice(0, 4))),
        date: Between(from, to),
      },
      select: { date: true },
    });
  }

  history(
    employeeId: string,
    from: string,
    to: string,
    manager: EntityManager,
  ): Promise<AttendanceEntity[]> {
    return manager.find(AttendanceEntity, {
      where: [
        { employeeId, workDate: Between(from, to) },
        { openEmployeeId: employeeId },
      ],
      relations: { photo: true },
      relationLoadStrategy: 'join',
    });
  }

  async detail(
    id: string,
    employeeId?: string,
  ): Promise<AttendanceEntity | null> {
    const [row] = await this.source.manager.find(AttendanceEntity, {
      where: { id, ...(employeeId ? { employeeId } : {}) },
      relations: { photo: true },
      relationLoadStrategy: 'join',
    });

    return row ?? null;
  }

  selectedRecords(
    employeeIds: string[],
    date: string,
    manager: EntityManager,
  ): Promise<AttendanceEntity[]> {
    if (!employeeIds.length) {
      return Promise.resolve([]);
    }

    return manager.find(AttendanceEntity, {
      where: [
        { employeeId: In(employeeIds), workDate: date },
        { openEmployeeId: In(employeeIds) },
      ],
      relations: { photo: true },
      relationLoadStrategy: 'join',
    });
  }
}
