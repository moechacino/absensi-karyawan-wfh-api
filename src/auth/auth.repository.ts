import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import {
  EmployeeEntity,
  DivisionEntity,
  PositionEntity,
  FileObjectEntity,
} from '../database/entities';

export interface AuthProfileData {
  employee: EmployeeEntity;
  division: DivisionEntity;
  position: PositionEntity;
  photo: FileObjectEntity | null;
}

@Injectable()
export class AuthRepository {
  constructor(private readonly source: DataSource) {}

  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.source.transaction('READ COMMITTED', work);
  }

  findCredentials(
    manager: EntityManager,
    where: { id: string } | { email: string },
  ): Promise<EmployeeEntity | null> {
    return manager.findOne(EmployeeEntity, {
      where,
      select: {
        id: true,
        createdAt: true,
        fullName: true,
        email: true,
        divisionId: true,
        positionId: true,
        role: true,
        status: true,
        photoFileId: true,
        version: true,
        updatedAt: true,
        hasPasswordChanged: true,
        initialPassword: true,
        passwordHash: true,
      },
      lock: { mode: 'pessimistic_write' },
    });
  }

  async changePassword(
    manager: EntityManager,
    employee: EmployeeEntity,
    hash: string,
  ): Promise<void> {
    await manager.update(
      EmployeeEntity,
      { id: employee.id },
      {
        initialPassword: null,
        passwordHash: hash,
        hasPasswordChanged: true,
        version: employee.version + 1,
      },
    );
  }

  async profile(manager: EntityManager, id: string): Promise<AuthProfileData> {
    const employee = await manager.findOneByOrFail(EmployeeEntity, { id });
    const [division, position, photo] = await Promise.all([
      manager.findOneByOrFail(DivisionEntity, { id: employee.divisionId }),
      manager.findOneByOrFail(PositionEntity, { id: employee.positionId }),
      employee.photoFileId
        ? manager.findOneBy(FileObjectEntity, {
            id: employee.photoFileId,
            ownerEmployeeId: id,
            state: 'ATTACHED',
            purpose: 'EMPLOYEE_PROFILE_PHOTO',
          })
        : Promise.resolve(null),
    ]);

    return { employee, division, position, photo };
  }
}
