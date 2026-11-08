import { Injectable } from '@nestjs/common';
import { DataSource, In, Raw } from 'typeorm';
import type { EntityManager, FindOptionsWhere } from 'typeorm';
import {
  DivisionEntity,
  PositionEntity,
  EmployeeEntity,
} from '../database/entities';
import type { DivisionQuery, PositionQuery } from './organization.dto';

type DivisionChanges = Partial<
  Pick<DivisionEntity, 'code' | 'name' | 'description' | 'status' | 'version'>
>;
type PositionChanges = Partial<
  Pick<PositionEntity, 'code' | 'name' | 'divisionId' | 'status' | 'version'>
>;

function filters<T extends DivisionEntity | PositionEntity>(
  query: DivisionQuery,
  base: FindOptionsWhere<T>,
): FindOptionsWhere<T>[] {
  if (!query.q) {
    return [base];
  }

  const pattern = '%' + query.q.replace(/[!%_]/g, '!$&') + '%';
  const match = Raw((alias) => `${alias} LIKE :pattern ESCAPE '!'`, {
    pattern,
  });

  return [
    { ...base, code: match },
    { ...base, name: match },
  ];
}

@Injectable()
export class OrganizationRepository {
  constructor(private readonly source: DataSource) {}

  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.source.transaction('READ COMMITTED', work);
  }

  listDivisions(query: DivisionQuery): Promise<[DivisionEntity[], number]> {
    return this.source.manager.findAndCount(DivisionEntity, {
      where: filters<DivisionEntity>(
        query,
        query.status ? { status: query.status } : {},
      ),
      order: { code: 'ASC', id: 'ASC' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });
  }

  listPositions(query: PositionQuery): Promise<[PositionEntity[], number]> {
    return this.source.manager.findAndCount(PositionEntity, {
      where: filters<PositionEntity>(query, {
        ...(query.status ? { status: query.status } : {}),
        ...(query.divisionId ? { divisionId: query.divisionId } : {}),
      }),
      order: { code: 'ASC', id: 'ASC' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });
  }

  divisions(ids: string[]): Promise<DivisionEntity[]> {
    return ids.length
      ? this.source.manager.findBy(DivisionEntity, { id: In(ids) })
      : Promise.resolve([]);
  }

  division(
    manager: EntityManager,
    id: string,
    lock = false,
  ): Promise<DivisionEntity | null> {
    return manager.findOne(DivisionEntity, {
      where: { id },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
  }

  position(
    manager: EntityManager,
    id: string,
    lock = false,
  ): Promise<PositionEntity | null> {
    return manager.findOne(PositionEntity, {
      where: { id },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
  }

  async insertDivision(
    manager: EntityManager,
    data: Pick<
      DivisionEntity,
      'id' | 'code' | 'name' | 'description' | 'status'
    >,
  ): Promise<DivisionEntity> {
    await manager.insert(DivisionEntity, data);

    return manager.findOneByOrFail(DivisionEntity, { id: data.id });
  }

  async insertPosition(
    manager: EntityManager,
    data: Pick<
      PositionEntity,
      'id' | 'code' | 'name' | 'divisionId' | 'status'
    >,
  ): Promise<PositionEntity> {
    await manager.insert(PositionEntity, data);

    return manager.findOneByOrFail(PositionEntity, { id: data.id });
  }

  async updateDivision(
    manager: EntityManager,
    id: string,
    data: DivisionChanges,
  ): Promise<DivisionEntity> {
    await manager.update(DivisionEntity, { id }, data);

    return manager.findOneByOrFail(DivisionEntity, { id });
  }

  async updatePosition(
    manager: EntityManager,
    id: string,
    data: PositionChanges,
  ): Promise<PositionEntity> {
    await manager.update(PositionEntity, { id }, data);

    return manager.findOneByOrFail(PositionEntity, { id });
  }

  positionHasEmployees(manager: EntityManager, id: string): Promise<boolean> {
    return manager.existsBy(EmployeeEntity, { positionId: id });
  }
}
