import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { EntityManager, QueryRunner } from 'typeorm';
import { IdempotencyOperationEntity } from '../database/entities';
import { Clock } from '../runtime/clock';
import { ProblemException } from '../http/problem';
import {
  inProgress,
  mysqlErrorCode,
  isRetryableTransactionError,
} from './idempotency.errors';
import type { PreparedRequest } from './idempotency.request';
import type { StoredResult } from './idempotency.types';

@Injectable()
export class IdempotencyRepository {
  constructor(
    private readonly source: DataSource,
    private readonly clock: Clock,
  ) {}

  // One connection owns the named lock and every transaction/retry until release.
  async runExclusive<T>(
    request: PreparedRequest,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const lock =
      'wfh-idem:' +
      createHash('sha256')
        .update(
          JSON.stringify([
            this.source.options.database,
            request.actorId,
            request.operation,
            request.key,
          ]),
        )
        .digest('hex')
        .slice(0, 55);

    const runner = this.source.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      await this.acquireLock(runner, lock);
      locked = true;
      return await this.withRetries(runner, work);
    } finally {
      try {
        if (runner.isTransactionActive) {
          await runner.rollbackTransaction();
        }

        if (locked) {
          await runner.query('SELECT RELEASE_LOCK(?)', [lock]);
        }
      } finally {
        await runner.release();
      }
    }
  }

  private async acquireLock(runner: QueryRunner, lock: string): Promise<void> {
    const [row]: { acquired: number | string | null }[] = await runner.query(
      'SELECT GET_LOCK(?, 0) AS acquired',
      [lock],
    );

    if (row.acquired === null) {
      throw new ProblemException(
        503,
        'SERVICE_UNAVAILABLE',
        'Operation coordination unavailable',
      );
    }

    if (Number(row.acquired) !== 1) {
      throw inProgress();
    }
  }

  private async withRetries<T>(
    runner: QueryRunner,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await runner.startTransaction('READ COMMITTED');
      try {
        const result = await work(runner.manager);
        await runner.commitTransaction();
        return result;
      } catch (error) {
        if (runner.isTransactionActive) {
          await runner.rollbackTransaction();
        }

        if (mysqlErrorCode(error) === 'ER_LOCK_NOWAIT') {
          throw inProgress();
        }

        if (!isRetryableTransactionError(error)) {
          throw error;
        }

        if (attempt === 2) {
          throw new ProblemException(
            503,
            'OPERATION_RETRY_EXHAUSTED',
            'Operation temporarily busy',
            { detail: 'Retry with the same idempotency key.', retryAfter: 1 },
          );
        }

        await new Promise((resolve) =>
          setTimeout(resolve, 5 + Math.floor(Math.random() * 20)),
        );
      }
    }
    throw new Error('Operation did not complete.');
  }

  findForUpdate(manager: EntityManager, request: PreparedRequest) {
    return manager
      .getRepository(IdempotencyOperationEntity)
      .createQueryBuilder('operation')
      .addSelect('operation.result')
      .where(
        'operation.actorId = :actorId AND operation.routeScope = :route AND operation.idempotencyKey = :key',
        {
          actorId: request.actorId,
          route: request.operation,
          key: request.key,
        },
      )
      .setLock('pessimistic_write')
      .setOnLocked('nowait')
      .getOne();
  }

  async remove(manager: EntityManager, id: string): Promise<void> {
    await manager.getRepository(IdempotencyOperationEntity).delete({ id });
  }

  async saveCompleted(
    manager: EntityManager,
    request: PreparedRequest,
    result: StoredResult,
    retentionSeconds: number,
  ): Promise<void> {
    const repository = manager.getRepository(IdempotencyOperationEntity);
    const completedAt = this.clock.now();
    const record = repository.create({
      id: randomUUID(),
      actorId: request.actorId,
      routeScope: request.operation,
      idempotencyKey: request.key,
      fingerprint: request.hash,
      state: 'COMPLETED',
      httpStatus: result.status,
      resourceId: result.resourceId ?? null,
      completedAt,
      expiresAt: new Date(completedAt.getTime() + retentionSeconds * 1000),
    });
    record.result = result.body;
    await repository.save(record);
  }

  // Explicit bounded operation for a future operations command; no timer/worker is registered.
  async cleanupExpired(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Cleanup batch must be between 1 and 1000.');
    }

    return this.source.transaction('READ COMMITTED', async (manager) => {
      const repository = manager.getRepository(IdempotencyOperationEntity);
      const rows = await repository
        .createQueryBuilder('operation')
        .where('operation.state = :state AND operation.expiresAt <= :now', {
          state: 'COMPLETED',
          now: this.clock.now(),
        })
        .orderBy('operation.expiresAt', 'ASC')
        .addOrderBy('operation.id', 'ASC')
        .take(limit)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      if (rows.length) {
        await repository.delete({ id: In(rows.map((row) => row.id)) });
      }

      return rows.length;
    });
  }
}
