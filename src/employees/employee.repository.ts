import { Injectable } from '@nestjs/common';
import { DataSource, Raw } from 'typeorm';
import type { EntityManager, FindOptionsWhere, FindOneOptions } from 'typeorm';
import { EmployeeEntity, PositionEntity } from '../database/entities';
import type { EmployeeQuery } from './employee.dto';

type EmployeeInsert = Pick<
  EmployeeEntity,
  | 'id'
  | 'fullName'
  | 'email'
  | 'divisionId'
  | 'positionId'
  | 'role'
  | 'status'
  | 'photoFileId'
  | 'hasPasswordChanged'
  | 'initialPassword'
  | 'passwordHash'
>;
type EmployeeChanges = Partial<
  Pick<
    EmployeeEntity,
    | 'fullName'
    | 'email'
    | 'divisionId'
    | 'positionId'
    | 'role'
    | 'status'
    | 'photoFileId'
    | 'version'
  >
>;

const viewOptions: FindOneOptions<EmployeeEntity> = {
  relations: { division: true, position: true, photo: true },
  relationLoadStrategy: 'join',
  select: {
    id: true,
    fullName: true,
    email: true,
    role: true,
    status: true,
    version: true,
    createdAt: true,
    updatedAt: true,
    hasPasswordChanged: true,
    photoFileId: true,
    division: { id: true, code: true, name: true },
    position: { id: true, code: true, name: true },
    photo: {
      id: true,
      fileName: true,
      mimeType: true,
      sizeBytes: true,
      ownerEmployeeId: true,
      state: true,
      purpose: true,
    },
  },
};

@Injectable()
export class EmployeeRepository {
  constructor(private readonly source: DataSource) {}

  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.source.transaction('READ COMMITTED', work);
  }

  list(query: EmployeeQuery): Promise<[EmployeeEntity[], number]> {
    const base: FindOptionsWhere<EmployeeEntity> = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.divisionId ? { divisionId: query.divisionId } : {}),
    };
    const pattern = '%' + (query.q ?? '').replace(/[!%_]/g, '!$&') + '%';
    const match = Raw((alias) => `${alias} LIKE :pattern ESCAPE '!'`, {
      pattern,
    });
    const where = query.q
      ? [
          { ...base, fullName: match },
          { ...base, email: match },
        ]
      : base;

    return Promise.all([
      this.source.manager.find(EmployeeEntity, {
        ...viewOptions,
        where,
        order: { fullName: 'ASC', id: 'ASC' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.source.manager.count(EmployeeEntity, { where }),
    ]);
  }

  async profile(
    id: string,
    manager: EntityManager = this.source.manager,
  ): Promise<EmployeeEntity | null> {
    // The primary key bounds this to one row; find avoids findOne's extra joined pagination query.
    const [employee] = await manager.find(EmployeeEntity, {
      ...viewOptions,
      where: { id },
    });

    return employee ?? null;
  }

  employee(
    manager: EntityManager | undefined,
    id: string,
    lock = false,
  ): Promise<EmployeeEntity | null> {
    return (manager ?? this.source.manager).findOne(EmployeeEntity, {
      where: { id },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
  }

  async position(
    manager: EntityManager,
    id: string,
    lock = false,
  ): Promise<PositionEntity | null> {
    const [position] = await manager.find(PositionEntity, {
      where: { id },
      relations: { division: true },
      relationLoadStrategy: 'join',
      select: {
        id: true,
        divisionId: true,
        status: true,
        division: { id: true, status: true },
      },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });

    return position ?? null;
  }

  async insertEmployee(
    manager: EntityManager,
    data: EmployeeInsert,
  ): Promise<void> {
    await manager.insert(EmployeeEntity, data);
  }

  async updateEmployee(
    manager: EntityManager,
    id: string,
    changes: EmployeeChanges,
  ): Promise<void> {
    await manager.update(EmployeeEntity, { id }, changes);
  }
}
