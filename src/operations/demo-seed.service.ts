import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';

import {
  DivisionEntity,
  EmployeeEntity,
  PositionEntity,
} from '../database/entities';
import { RUNTIME_CONFIG } from '../runtime/runtime.config';
import type { RuntimeConfig } from '../runtime/runtime.config';
import { DEMO_DIVISIONS, DEMO_PASSWORD, DEMO_PEOPLE } from './demo-seed.data';
import { DemoSeedRepository } from './demo-seed.repository';

@Injectable()
export class DemoSeedService {
  constructor(
    private readonly repository: DemoSeedRepository,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  async seed(password = DEMO_PASSWORD) {
    if (this.config.app.environment === 'production') {
      throw new Error(
        'Fictional people seeding requires NODE_ENV=development or test.',
      );
    }

    if (Array.from(password).length < 8 || Array.from(password).length > 128) {
      throw new Error('Seed password requires 8–128 Unicode code points.');
    }

    return this.repository.transaction(async (manager) => {
      await this.repository.lock(manager);
      const existing = await this.repository.existing(manager);
      const divisions = new Map<
        string,
        Pick<DivisionEntity, 'id' | 'code' | 'status'>
      >(existing.divisions.map((row) => [row.code.toUpperCase(), row]));
      const positions = new Map<
        string,
        Pick<PositionEntity, 'id' | 'code' | 'divisionId' | 'status'>
      >(existing.positions.map((row) => [row.code.toUpperCase(), row]));
      const employees = new Map(
        existing.employees.map((row) => [row.email.toLowerCase(), row]),
      );
      const rows = {
        divisions: [] as Partial<DivisionEntity>[],
        positions: [] as Partial<PositionEntity>[],
        employees: [] as Partial<EmployeeEntity>[],
      };

      for (const division of DEMO_DIVISIONS) {
        let savedDivision = divisions.get(division.code);

        if (!savedDivision) {
          savedDivision = {
            id: randomUUID(),
            code: division.code,
            status: 'ACTIVE',
          };
          divisions.set(division.code, savedDivision);
          rows.divisions.push({
            id: savedDivision.id,
            code: division.code,
            status: 'ACTIVE',
            name: division.name,
          });
        }

        const code = `${division.code}-STAFF`;
        const savedPosition = positions.get(code);

        if (
          savedDivision.status !== 'ACTIVE' ||
          (savedPosition &&
            (savedPosition.divisionId !== savedDivision.id ||
              savedPosition.status !== 'ACTIVE'))
        ) {
          throw new Error(
            'A demo division/position was changed or deactivated; no seed data was written.',
          );
        }

        if (!savedPosition) {
          const position = {
            id: randomUUID(),
            code,
            divisionId: savedDivision.id,
            status: 'ACTIVE' as const,
          };
          positions.set(code, position);
          rows.positions.push({ ...position, name: division.position });
        }
      }

      for (const person of DEMO_PEOPLE) {
        const divisionId = divisions.get(person.divisionCode)!.id;
        const positionId = positions.get(person.positionCode)!.id;
        const saved = employees.get(person.email);

        if (saved) {
          if (
            saved.divisionId !== divisionId ||
            saved.positionId !== positionId
          ) {
            throw new Error(
              'An existing demo email has different organization references; no seed data was written.',
            );
          }

          continue;
        }

        rows.employees.push({
          id: randomUUID(),
          fullName: person.fullName,
          email: person.email,
          role: person.role,
          status: 'ACTIVE',
          divisionId,
          positionId,
          initialPassword: password,
          passwordHash: null,
          hasPasswordChanged: false,
          photoFileId: null,
        });
      }

      await this.repository.insert(manager, rows);
      const hr = rows.employees.filter((row) => row.role === 'HRD').length;

      return {
        total: DEMO_PEOPLE.length,
        created: {
          hr,
          employees: rows.employees.length - hr,
          divisions: rows.divisions.length,
          positions: rows.positions.length,
        },
        skipped: DEMO_PEOPLE.length - rows.employees.length,
      };
    });
  }
}
