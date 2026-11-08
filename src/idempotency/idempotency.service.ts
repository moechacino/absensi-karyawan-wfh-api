import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { IdempotencyOperationEntity } from '../database/entities';
import { Clock } from '../runtime/clock';
import { RUNTIME_CONFIG } from '../runtime/runtime.config';
import type { RuntimeConfig } from '../runtime/runtime.config';
import { ProblemException } from '../http/problem';
import { publicReceipt } from './fingerprint';
import { IdempotencyRepository } from './idempotency.repository';
import { prepareRequest } from './idempotency.request';
import type { PreparedRequest } from './idempotency.request';
import { inProgress } from './idempotency.errors';
import { uuid } from './idempotency.types';
import type {
  IdempotencyCommand,
  IdempotencyHandlers,
  StoredResult,
  IdempotentResult,
} from './idempotency.types';

export type {
  StoredResult,
  IdempotentResult,
  IdempotentOperation,
} from './idempotency.types';

@Injectable()
export class IdempotencyService {
  constructor(
    private readonly repository: IdempotencyRepository,
    private readonly clock: Clock,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  async execute(
    command: IdempotencyCommand,
    handlers: IdempotencyHandlers,
  ): Promise<IdempotentResult> {
    const request = prepareRequest(command, handlers, this.clock);

    return this.repository.runExclusive(request, async (manager) => {
      await handlers.authorize(manager);
      const previous = await this.repository.findForUpdate(manager, request);
      const cached = await this.findReplay(manager, request, previous);
      const replayed = cached !== null;
      const result = cached ?? (await this.perform(manager, request, handlers));
      const body = handlers.present
        ? await handlers.present(manager, result, replayed)
        : result.body;

      return { status: result.status, body, replayed };
    });
  }

  private async findReplay(
    manager: EntityManager,
    request: PreparedRequest,
    previous: IdempotencyOperationEntity | null,
  ): Promise<StoredResult | null> {
    if (!previous) {
      return null;
    }

    const now = this.clock.now();

    if (previous.expiresAt > now && previous.fingerprint !== request.hash) {
      throw new ProblemException(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency key reused',
        {
          detail: 'Use a new key for changed input.',
        },
      );
    }

    if (
      previous.state === 'IN_PROGRESS' &&
      (!previous.leaseExpiresAt || previous.leaseExpiresAt > now)
    ) {
      throw inProgress();
    }

    if (previous.expiresAt <= now || previous.state === 'IN_PROGRESS') {
      await this.repository.remove(manager, previous.id);

      return null;
    }

    return {
      status: previous.httpStatus!,
      body: publicReceipt(previous.result),
      ...(previous.resourceId ? { resourceId: previous.resourceId } : {}),
    };
  }

  private async perform(
    manager: EntityManager,
    request: PreparedRequest,
    handlers: IdempotencyHandlers,
  ): Promise<StoredResult> {
    const result = await handlers.perform(manager, {
      receivedAt: new Date(request.receivedAt),
    });

    if (
      !Number.isInteger(result.status) ||
      result.status < 200 ||
      result.status > 299 ||
      (result.resourceId !== undefined && !uuid.test(result.resourceId))
    ) {
      throw new Error('Invalid completed operation result.');
    }

    const receipt = { ...result, body: publicReceipt(result.body) };

    if (
      request.operation === 'createEmployee' &&
      (Object.keys(receipt.body).length !== 1 ||
        typeof receipt.body.employeeId !== 'string' ||
        !uuid.test(receipt.body.employeeId))
    ) {
      throw new Error('Employee receipt must contain only employeeId.');
    }

    await this.repository.saveCompleted(
      manager,
      request,
      receipt,
      this.config.policy.idempotencyRetentionSeconds,
    );

    return receipt;
  }

  cleanupExpired(limit = 100): Promise<number> {
    return this.repository.cleanupExpired(limit);
  }
}
