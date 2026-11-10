import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { EntityManager } from 'typeorm';

import {
  CalendarStateEntity,
  DivisionEntity,
  EmployeeEntity,
  PositionEntity,
} from '../database/entities';
import { DEMO_DIVISIONS, DEMO_PEOPLE } from './demo-seed.data';

@Injectable()
export class DemoSeedRepository {
  constructor(private readonly source: DataSource) {}

  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.source.transaction('READ COMMITTED', work);
  }

  async lock(manager: EntityManager): Promise<void> {
    // Shared with first-HRD provisioning so concurrent CLI runs cannot duplicate the seed.
    await manager.findOneOrFail(CalendarStateEntity, {
      where: { id: 1 },
      lock: { mode: 'pessimistic_write' },
    });
  }

  async existing(manager: EntityManager) {
    const [divisions, positions, employees] = await Promise.all([
      manager.find(DivisionEntity, {
        where: { code: In(DEMO_DIVISIONS.map((row) => row.code)) },
        select: { id: true, code: true, status: true },
      }),
      manager.find(PositionEntity, {
        where: { code: In(DEMO_DIVISIONS.map((row) => `${row.code}-STAFF`)) },
        select: { id: true, code: true, divisionId: true, status: true },
      }),
      manager.find(EmployeeEntity, {
        where: { email: In(DEMO_PEOPLE.map((row) => row.email)) },
        select: { id: true, email: true, divisionId: true, positionId: true },
      }),
    ]);

    return { divisions, positions, employees };
  }

  async insert(
    manager: EntityManager,
    rows: {
      divisions: Partial<DivisionEntity>[];
      positions: Partial<PositionEntity>[];
      employees: Partial<EmployeeEntity>[];
    },
  ): Promise<void> {
    if (rows.divisions.length)
      await manager.insert(DivisionEntity, rows.divisions);
    if (rows.positions.length)
      await manager.insert(PositionEntity, rows.positions);
    if (rows.employees.length)
      await manager.insert(EmployeeEntity, rows.employees);
  }
}
