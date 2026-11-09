import { Injectable } from '@nestjs/common';
import { ProblemException } from '../http/problem';
import { IdempotencyService } from './idempotency.service';
import type { EntityManager } from 'typeorm';
import type { JsonObject, Json } from './fingerprint';
import type { IdempotencyCommand } from './idempotency.types';

export interface CommandResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

export interface LocalCommandOptions<T extends JsonObject, R extends Json> {
  status?: number;
  present?: (
    manager: EntityManager,
    receipt: T,
    replayed: boolean,
  ) => Promise<R>;
}

@Injectable()
export class LocalCommandRunner {
  constructor(private readonly idempotency: IdempotencyService) {}

  // Called after guards and DTO pipes. Only local SQL work may run inside this transaction.

  async run<T extends JsonObject, R extends Json = T>(
    command: IdempotencyCommand,
    work: (manager: EntityManager) => Promise<T>,
    options: LocalCommandOptions<T, R> = {},
  ): Promise<CommandResult<R>> {
    if (typeof command.key !== 'string') {
      throw new ProblemException(
        400,
        'INVALID_IDEMPOTENCY_KEY',
        'A UUID idempotency key is required',
      );
    }

    const present = options.present;
    const result = await this.idempotency.execute(command, {
      perform: async (manager) => {
        const body = await work(manager);
        return {
          status: options.status ?? 201,
          body,
          ...(typeof body.id === 'string' ? { resourceId: body.id } : {}),
        };
      },
      ...(present
        ? {
            present: (
              manager: EntityManager,
              result: { body: JsonObject },
              replayed: boolean,
            ) => present(manager, result.body as T, replayed),
          }
        : {}),
    });
    // The caller owns the receipt and public projection for its operation.
    return { ...result, body: result.body as R };
  }
}
