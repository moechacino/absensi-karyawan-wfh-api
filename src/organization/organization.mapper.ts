import type { DivisionEntity, PositionEntity } from '../database/entities';
import type { DivisionView, PositionView, Page } from './organization.types';
import type { DivisionQuery } from './organization.dto';

export function mapDivision(row: DivisionEntity): DivisionView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    version: row.version,
  };
}

export function mapPosition(
  row: PositionEntity,
  division: DivisionEntity,
): PositionView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    division: { id: division.id, code: division.code, name: division.name },
    status: row.status,
    version: row.version,
  };
}

export function page<T>(
  items: T[],
  totalItems: number,
  query: DivisionQuery,
): Page<T> {
  return {
    items,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / query.pageSize),
    },
  };
}
