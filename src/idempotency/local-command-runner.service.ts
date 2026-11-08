import { Injectable } from '@nestjs/common';
import { ProblemException } from '../http/problem';
import { IdempotencyService } from './idempotency.service';
import type { EntityManager } from 'typeorm';
import type { JsonObject } from './fingerprint';

export interface LocalCreateCommand {
  actorId: string;
  operation: 'createDivision' | 'createPosition';
  key: string;
  input: JsonObject;
}

export interface CommandResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

@Injectable()
export class LocalCommandRunner {
  constructor(private readonly idempotency: IdempotencyService) {}

  // Called after guards and DTO pipes. Only local SQL work may run inside this transaction.
  async run<T extends JsonObject>(
    command: LocalCreateCommand,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<CommandResult<T>> {
    if (typeof command.key !== 'string') {
      throw new ProblemException(
        400,
        'INVALID_IDEMPOTENCY_KEY',
        'A UUID idempotency key is required',
      );
    }

    const result = await this.idempotency.execute(command, {
      perform: async (manager) => {
        const body = await work(manager);

        return {
          status: 201,
          body,
          ...(typeof body.id === 'string' ? { resourceId: body.id } : {}),
        };
      },
    });

    // The same operation/fingerprint identifies the original public response shape.
    return { ...result, body: result.body as T };
  }
}
