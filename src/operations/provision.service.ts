import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { RUNTIME_CONFIG } from '../runtime/runtime.config';
import type { RuntimeConfig } from '../runtime/runtime.config';

import { ProvisionRepository } from './provision.repository';
import type { ProvisionInput } from './operations.input';

@Injectable()
export class ProvisionService {
  constructor(
    private readonly repository: ProvisionRepository,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  async firstHrd(
    input: ProvisionInput,
    fictional = false,
  ): Promise<{ employeeId: string }> {
    if (fictional && this.config.app.environment !== 'development') {
      throw new Error(
        'Fictional data is allowed only with NODE_ENV=development.',
      );
    }

    const values = fictional
      ? {
          initialPassword: input.initialPassword,
          fullName: 'Fictional HRD',
          email: 'fictional-hrd@example.test',
          divisionCode: 'DEMO',
          divisionName: 'Fictional division',
          positionCode: 'DEMO-HRD',
          positionName: 'Fictional HRD position',
        }
      : input;

    return this.repository.transaction(async (manager) => {
      await this.repository.lockInstallation(manager);

      if (await this.repository.employeeCount(manager)) {
        throw new Error(
          'Provisioning requires an empty employee table; no account was changed.',
        );
      }

      const ids = {
        employeeId: randomUUID(),
        divisionId: randomUUID(),
        positionId: randomUUID(),
      };
      await this.repository.insert(values, ids, manager);

      return { employeeId: ids.employeeId };
    });
  }
}
