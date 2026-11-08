import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { DivisionEntity } from '../database/entities';
import { ProblemException } from '../http/problem';
import { OrganizationRepository } from './organization.repository';
import { mapDivision, mapPosition, page } from './organization.mapper';
import type {
  DivisionCreate,
  DivisionPatch,
  DivisionQuery,
  PositionCreate,
  PositionPatch,
  PositionQuery,
} from './organization.dto';
import type { DivisionView, PositionView, Page } from './organization.types';

function version(actual: number, expected: number, id: string): void {
  if (actual !== expected) {
    throw new ProblemException(
      409,
      'VERSION_CONFLICT',
      'Resource version changed',
      { details: { resourceId: id, currentVersion: actual } },
    );
  }
}

function meaningful(changes: object): void {
  if (!Object.values(changes).some((value) => value !== undefined)) {
    throw new ProblemException(
      400,
      'VALIDATION_FAILED',
      'Include at least one editable field',
    );
  }
}

async function uniqueCode<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const driver =
      error && typeof error === 'object' && 'driverError' in error
        ? error.driverError
        : error;

    if (
      driver &&
      typeof driver === 'object' &&
      'code' in driver &&
      driver.code === 'ER_DUP_ENTRY'
    ) {
      throw new ProblemException(
        409,
        'CODE_ALREADY_EXISTS',
        'Organization code already exists',
      );
    }

    throw error;
  }
}

@Injectable()
export class OrganizationService {
  constructor(private readonly repository: OrganizationRepository) {}

  async listDivisions(query: DivisionQuery): Promise<Page<DivisionView>> {
    const [rows, total] = await this.repository.listDivisions(query);

    return page(rows.map(mapDivision), total, query);
  }

  async listPositions(query: PositionQuery): Promise<Page<PositionView>> {
    const [rows, total] = await this.repository.listPositions(query);
    const divisions = new Map(
      (
        await this.repository.divisions([
          ...new Set(rows.map((row) => row.divisionId)),
        ])
      ).map((row) => [row.id, row]),
    );

    return page(
      rows.map((row) => mapPosition(row, divisions.get(row.divisionId)!)),
      total,
      query,
    );
  }

  createDivision(
    input: DivisionCreate,
    manager: EntityManager,
  ): Promise<DivisionView> {
    return uniqueCode(async () => {
      const row = await this.repository.insertDivision(manager, {
        id: randomUUID(),
        code: input.code,
        name: input.name,
        status: input.status,
        description: input.description ?? null,
      });

      return mapDivision(row);
    });
  }

  createPosition(
    input: PositionCreate,
    manager: EntityManager,
  ): Promise<PositionView> {
    return uniqueCode(async () => {
      const division = await this.activeDivision(manager, input.divisionId);
      const row = await this.repository.insertPosition(manager, {
        id: randomUUID(),
        code: input.code,
        name: input.name,
        status: input.status,
        divisionId: input.divisionId,
      });

      return mapPosition(row, division);
    });
  }

  updateDivision(id: string, input: DivisionPatch): Promise<DivisionView> {
    const { expectedVersion, ...changes } = input;
    meaningful(changes);

    return uniqueCode(() =>
      this.repository.transaction(async (manager) => {
        const existing = await this.repository.division(manager, id, true);

        if (!existing) {
          throw new ProblemException(
            404,
            'DIVISION_NOT_FOUND',
            'Division not found',
          );
        }

        version(existing.version, expectedVersion, id);

        return mapDivision(
          await this.repository.updateDivision(manager, id, {
            ...changes,
            version: existing.version + 1,
          }),
        );
      }),
    );
  }

  updatePosition(id: string, input: PositionPatch): Promise<PositionView> {
    const { expectedVersion, ...changes } = input;
    meaningful(changes);

    return uniqueCode(() =>
      this.repository.transaction(async (manager) => {
        const existing = await this.repository.position(manager, id, true);

        if (!existing) {
          throw new ProblemException(
            404,
            'POSITION_NOT_FOUND',
            'Position not found',
          );
        }

        version(existing.version, expectedVersion, id);
        const moved =
          input.divisionId !== undefined &&
          input.divisionId !== existing.divisionId;

        if (
          moved &&
          (await this.repository.positionHasEmployees(manager, id))
        ) {
          throw new ProblemException(
            409,
            'POSITION_IN_USE',
            'A referenced position cannot change divisions',
          );
        }

        const divisionId = input.divisionId ?? existing.divisionId;
        const assigning =
          moved ||
          (existing.status === 'INACTIVE' && input.status === 'ACTIVE');
        const division = assigning
          ? await this.activeDivision(manager, divisionId)
          : await this.repository.division(manager, divisionId);

        if (!division) {
          throw new ProblemException(
            404,
            'DIVISION_NOT_FOUND',
            'Division not found',
          );
        }

        return mapPosition(
          await this.repository.updatePosition(manager, id, {
            ...changes,
            version: existing.version + 1,
          }),
          division,
        );
      }),
    );
  }

  private async activeDivision(
    manager: EntityManager,
    id: string,
  ): Promise<DivisionEntity> {
    const division = await this.repository.division(manager, id, true);

    if (!division) {
      throw new ProblemException(
        404,
        'DIVISION_NOT_FOUND',
        'Division not found',
      );
    }

    if (division.status !== 'ACTIVE') {
      throw new ProblemException(
        422,
        'DIVISION_INACTIVE',
        'Choose an active division',
      );
    }

    return division;
  }
}
