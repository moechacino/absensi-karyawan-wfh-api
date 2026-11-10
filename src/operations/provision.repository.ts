import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';

import {
  CalendarStateEntity,
  DivisionEntity,
  PositionEntity,
  EmployeeEntity,
} from '../database/entities';

import type { ProvisionInput } from './operations.input';

@Injectable()
export class ProvisionRepository {
  constructor(private readonly source: DataSource) {}

  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.source.transaction('READ COMMITTED', work);
  }

  async lockInstallation(manager: EntityManager): Promise<void> {
    await manager.findOneOrFail(CalendarStateEntity, {
      where: { id: 1 },
      lock: { mode: 'pessimistic_write' },
    });
  }

  employeeCount(manager: EntityManager): Promise<number> {
    return manager.count(EmployeeEntity);
  }

  async insert(
    input: ProvisionInput,
    ids: { employeeId: string; divisionId: string; positionId: string },
    manager: EntityManager,
  ): Promise<void> {
    await manager.insert(DivisionEntity, {
      id: ids.divisionId,
      code: input.divisionCode,
      name: input.divisionName,
      status: 'ACTIVE',
    });
    await manager.insert(PositionEntity, {
      id: ids.positionId,
      divisionId: ids.divisionId,
      code: input.positionCode,
      name: input.positionName,
      status: 'ACTIVE',
    });
    await manager.insert(EmployeeEntity, {
      id: ids.employeeId,
      divisionId: ids.divisionId,
      positionId: ids.positionId,
      fullName: input.fullName,
      email: input.email,
      role: 'HRD',
      status: 'ACTIVE',
      initialPassword: input.initialPassword,
      passwordHash: null,
      hasPasswordChanged: false,
      photoFileId: null,
    });
  }
}
