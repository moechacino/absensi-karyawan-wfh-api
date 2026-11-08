import { randomUUID } from 'node:crypto';
import { In } from 'typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { IdempotencyRepository } from '../src/idempotency/idempotency.repository';
import { IdempotencyService } from '../src/idempotency/idempotency.service';
import type { StoredResult } from '../src/idempotency/idempotency.service';
import { digestFile, fingerprint } from '../src/idempotency/fingerprint';
import { Clock } from '../src/runtime/clock';
import { loadRuntimeConfig } from '../src/runtime/runtime.config';
import { createDataSource } from '../src/database/data-source';
import {
  DivisionEntity,
  PositionEntity,
  EmployeeEntity,
  FileObjectEntity,
  ScheduleVersionEntity,
  IdempotencyOperationEntity,
} from '../src/database/entities';
import { ProblemException } from '../src/http/problem';
import { insertFixture, prepareTestDatabase } from './mysql-fixture';

class TestClock extends Clock {
  value = new Date('2026-11-08T01:00:00Z');

  now() {
    return new Date(this.value);
  }
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

describe('SQL idempotency coordination', () => {
  let source: DataSource;
  let service: IdempotencyService;
  let clock: TestClock;
  let ids: Awaited<ReturnType<typeof insertFixture>>;
  let extraEmployees: string[];
  let retentionMs: number;
  beforeAll(async () => {
    source = await prepareTestDatabase();
  });
  afterAll(async () => {
    await source?.destroy();
  });
  beforeEach(async () => {
    clock = new TestClock();
    retentionMs = loadRuntimeConfig().policy.idempotencyRetentionSeconds * 1000;
    service = new IdempotencyService(
      new IdempotencyRepository(source, clock),
      clock,
      loadRuntimeConfig(),
    );
    extraEmployees = [];
    ids = await source.transaction('READ COMMITTED', (manager) =>
      insertFixture(manager),
    );
  });
  afterEach(async () => {
    await source.manager.delete(IdempotencyOperationEntity, {
      actorId: In([ids.employee, ids.otherEmployee]),
    });

    if (extraEmployees.length) {
      await source.manager.delete(EmployeeEntity, { id: In(extraEmployees) });
    }

    await source.manager.delete(ScheduleVersionEntity, { id: ids.schedule });
    await source.manager.delete(FileObjectEntity, { id: ids.file });
    await source.manager.delete(EmployeeEntity, {
      id: In([ids.employee, ids.otherEmployee]),
    });
    await source.manager.delete(PositionEntity, { id: ids.position });
    await source.manager.delete(DivisionEntity, { id: ids.division });
  });
  const authorized = async () => {};

  function command(key = randomUUID()) {
    return {
      actorId: ids.employee,
      operation: 'createDivision' as const,
      key,
      input: { name: 'Fixture' },
    };
  }

  async function increment(manager: EntityManager): Promise<StoredResult> {
    expect(manager.queryRunner?.isTransactionActive).toBe(true);
    await manager.increment(DivisionEntity, { id: ids.division }, 'version', 1);
    return {
      status: 201,
      body: { divisionId: ids.division },
      resourceId: ids.division,
    };
  }

  async function version() {
    return (
      await source.manager.findOneByOrFail(DivisionEntity, { id: ids.division })
    ).version;
  }

  it('commits once and replays the original status/result after a lost response or changed current version', async () => {
    const request = command();
    let mutations = 0;
    let authorizations = 0;
    const handlers = {
      authorize: async () => {
        authorizations++;
      },
      perform: async (manager: EntityManager) => {
        mutations++;
        return increment(manager);
      },
    };
    const first = await service.execute(request, handlers);
    const replay = await service.execute(request, handlers);
    expect(first).toEqual({
      status: 201,
      body: { divisionId: ids.division },
      replayed: false,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await version()).toBe(2);
    expect(mutations).toBe(1);
    expect(authorizations).toBe(2);
    const stored = await source.manager.findOneByOrFail(
      IdempotencyOperationEntity,
      { actorId: ids.employee },
    );
    expect(stored.result).toBeUndefined();
    expect(stored.expiresAt.getTime() - stored.completedAt!.getTime()).toBe(
      86400000,
    );
    expect(stored.state).toBe('COMPLETED');
    expect(stored.leaseOwner).toBeNull();
  });

  it('binds parsed body/file digest/target while isolating actor and operation scopes', async () => {
    const request = {
      ...command(),
      input: { expectedVersion: 1, name: 'Fixture' },
      files: [digestFile('photo', Buffer.from('first bytes'))],
    };
    const handlers = { authorize: authorized, perform: increment };
    await service.execute(request, handlers);
    expect(
      (
        await service.execute(
          { ...request, input: { name: 'Fixture', expectedVersion: 1 } },
          handlers,
        )
      ).replayed,
    ).toBe(true);
    await expect(
      service.execute(
        { ...request, input: { expectedVersion: 2, name: 'Fixture' } },
        handlers,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(
      service.execute(
        {
          ...request,
          files: [digestFile('photo', Buffer.from('changed bytes'))],
        },
        handlers,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(
      service.execute({ ...request, resourceId: randomUUID() }, handlers),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(
      (
        await service.execute(
          { ...request, actorId: ids.otherEmployee },
          handlers,
        )
      ).replayed,
    ).toBe(false);
    expect(
      (
        await service.execute(
          { ...request, operation: 'createPosition' },
          handlers,
        )
      ).replayed,
    ).toBe(false);
    expect(await version()).toBe(4);
  });

  it('rejects an in-flight duplicate promptly across service instances, then replays completion', async () => {
    const request = command();
    const entered = gate();
    const release = gate();
    const work = service.execute(request, {
      authorize: authorized,
      perform: async (manager) => {
        await increment(manager);
        entered.resolve();
        await release.promise;
        return { status: 200, body: { ok: true } };
      },
    });
    await entered.promise;
    clock.value = new Date(clock.value.getTime() + retentionMs + 1000);
    try {
      const other = new IdempotencyService(
        new IdempotencyRepository(source, clock),
        clock,
        loadRuntimeConfig(),
      );
      await expect(
        other.execute(request, { authorize: authorized, perform: increment }),
      ).rejects.toMatchObject({
        code: 'OPERATION_IN_PROGRESS',
        publicOptions: { retryAfter: 1 },
      });
    } finally {
      release.resolve();
    }
    await work;
    expect(
      (
        await service.execute(request, {
          authorize: authorized,
          perform: increment,
        })
      ).replayed,
    ).toBe(true);
    expect(await version()).toBe(2);
  });

  it('rolls back partial work and releases coordination after mutation/projection failures', async () => {
    const request = command();
    await expect(
      service.execute(request, {
        authorize: authorized,
        perform: async (manager) => {
          await increment(manager);
          throw new Error('failure before commit');
        },
      }),
    ).rejects.toThrow('failure before commit');
    expect(await version()).toBe(1);
    expect(await source.manager.count(IdempotencyOperationEntity)).toBe(0);
    await expect(
      service.execute(
        { ...request, operation: 'createEmployee' },
        {
          authorize: authorized,
          perform: async (manager) => {
            await increment(manager);
            return { status: 201, body: { employeeId: ids.otherEmployee } };
          },
          present: async () => {
            throw new Error('response mapping failed');
          },
        },
      ),
    ).rejects.toThrow('response mapping failed');
    expect(await version()).toBe(1);
    expect(await source.manager.count(IdempotencyOperationEntity)).toBe(0);
    expect(
      (
        await service.execute(request, {
          authorize: authorized,
          perform: increment,
        })
      ).replayed,
    ).toBe(false);
    expect(await version()).toBe(2);
  });

  it('reauthorizes before exposing a stored result and never repeats mutation on unauthorized replay', async () => {
    const request = command();
    await service.execute(request, {
      authorize: authorized,
      perform: increment,
    });
    await expect(
      service.execute(request, {
        authorize: async () => {
          throw new ProblemException(403, 'FORBIDDEN', 'Forbidden');
        },
        perform: increment,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await version()).toBe(2);
    expect(await source.manager.count(IdempotencyOperationEntity)).toBe(1);
  });

  it('stores only an employeeId receipt and reconstructs credentials, returning unavailable after self change', async () => {
    const employeeId = randomUUID();
    extraEmployees.push(employeeId);
    const request = {
      ...command(),
      operation: 'createEmployee' as const,
      input: { email: 'created@example.test' },
    };
    let creates = 0;
    const handlers = {
      authorize: authorized,
      perform: async (manager: EntityManager) => {
        creates++;
        await manager.insert(EmployeeEntity, {
          id: employeeId,
          fullName: 'Created fixture',
          email: 'created@example.test',
          divisionId: ids.division,
          positionId: ids.position,
          initialPassword: 'Fictional-Initial-Password-Only',
          hasPasswordChanged: false,
        });
        return { status: 201, body: { employeeId }, resourceId: employeeId };
      },
      present: async (manager: EntityManager) => {
        const employee = await manager
          .getRepository(EmployeeEntity)
          .createQueryBuilder('employee')
          .addSelect('employee.initialPassword')
          .where('employee.id = :id', { id: employeeId })
          .setLock('pessimistic_read')
          .getOneOrFail();

        if (employee.hasPasswordChanged) {
          throw new ProblemException(
            409,
            'INITIAL_CREDENTIALS_UNAVAILABLE',
            'Initial credentials unavailable',
            { details: { employeeId, alreadyCreated: true } },
          );
        }

        return {
          employeeId,
          initialCredentials: {
            email: employee.email,
            initialPassword: employee.initialPassword!,
          },
        };
      },
    };
    const first = await service.execute(request, handlers);
    expect(JSON.stringify(first.body)).toContain(
      'Fictional-Initial-Password-Only',
    );
    const [receipt] = await source.query(
      'SELECT result FROM idempotency_operations WHERE actor_id = ?',
      [ids.employee],
    );
    expect(receipt.result).toEqual({ employeeId });
    expect((await service.execute(request, handlers)).replayed).toBe(true);
    await source.manager.update(
      EmployeeEntity,
      { id: employeeId },
      {
        initialPassword: null,
        passwordHash: 'fixture-personal-hash',
        hasPasswordChanged: true,
      },
    );
    await expect(service.execute(request, handlers)).rejects.toMatchObject({
      code: 'INITIAL_CREDENTIALS_UNAVAILABLE',
      publicOptions: { details: { employeeId, alreadyCreated: true } },
    });
    expect(creates).toBe(1);
    expect(await source.manager.count(IdempotencyOperationEntity)).toBe(1);
  });

  it('rejects secret-bearing caches and unsupported/malformed requests without a committed effect', async () => {
    const request = command();
    await expect(
      service.execute(request, {
        authorize: authorized,
        perform: async (manager) => {
          await increment(manager);
          return {
            status: 200,
            body: { nested: { accessToken: 'private-marker' } },
          };
        },
      }),
    ).rejects.toThrow('cannot be cached');
    expect(await version()).toBe(1);
    expect(await source.manager.count(IdempotencyOperationEntity)).toBe(0);
    await expect(
      service.execute(
        { ...request, key: 'not-a-uuid' },
        { authorize: authorized, perform: increment },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
    await expect(
      service.execute(
        { ...request, operation: 'login' as never },
        { authorize: authorized, perform: increment },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
    await expect(
      service.execute(
        { ...request, operation: 'checkIn' },
        { authorize: authorized, perform: increment },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('expires receipts in bounded batches without bypassing regular version validation', async () => {
    const request = command();
    const handlers = {
      authorize: authorized,
      perform: async (manager: EntityManager) => {
        const changed = await manager.update(
          DivisionEntity,
          { id: ids.division, version: 1 },
          { version: 2 },
        );

        if (changed.affected !== 1) {
          throw new ProblemException(
            409,
            'VERSION_CONFLICT',
            'Version conflict',
          );
        }

        return { status: 200, body: { version: 2 } };
      },
    };
    await service.execute(request, handlers);
    clock.value = new Date(clock.value.getTime() + retentionMs - 1000);
    expect(await service.cleanupExpired()).toBe(0);
    expect((await service.execute(request, handlers)).replayed).toBe(true);
    clock.value = new Date(clock.value.getTime() + 1000);
    expect(await service.cleanupExpired(1)).toBe(1);
    await expect(service.execute(request, handlers)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(await version()).toBe(2);
    await expect(service.cleanupExpired(1001)).rejects.toThrow(
      'between 1 and 1000',
    );
  });

  it('skips cleanup rows locked by a replay and preserves in-progress records', async () => {
    await service.execute(command(), {
      authorize: authorized,
      perform: increment,
    });
    const pending = {
      id: randomUUID(),
      actorId: ids.employee,
      routeScope: 'createDivision',
      idempotencyKey: randomUUID(),
      fingerprint: 'a'.repeat(64),
      state: 'IN_PROGRESS' as const,
      leaseOwner: 'fixture',
      leaseExpiresAt: clock.now(),
      expiresAt: clock.now(),
    };
    await source.manager.insert(IdempotencyOperationEntity, pending);
    clock.value = new Date(clock.value.getTime() + retentionMs);
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction('READ COMMITTED');
    try {
      await runner.query(
        "SELECT id FROM idempotency_operations WHERE state = 'COMPLETED' FOR UPDATE",
      );
      expect(await service.cleanupExpired()).toBe(0);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    expect(await service.cleanupExpired()).toBe(1);
    expect(await source.manager.count(IdempotencyOperationEntity)).toBe(1);
  });

  it('recovers an expired pending claim only when its row is unlocked', async () => {
    const request = command();
    const pending = {
      id: randomUUID(),
      actorId: ids.employee,
      routeScope: request.operation,
      idempotencyKey: request.key,
      fingerprint: fingerprint(request.input),
      state: 'IN_PROGRESS' as const,
      leaseOwner: 'fixture',
      leaseExpiresAt: new Date(clock.value.getTime() + 1000),
      expiresAt: new Date(clock.value.getTime() + retentionMs),
    };
    await source.manager.insert(IdempotencyOperationEntity, pending);
    await expect(
      service.execute(request, { authorize: authorized, perform: increment }),
    ).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
    clock.value = new Date(clock.value.getTime() + 1000);
    const runner = source.createQueryRunner();
    await runner.connect();
    await runner.startTransaction('READ COMMITTED');
    try {
      await runner.query(
        'SELECT id FROM idempotency_operations WHERE id = ? FOR UPDATE',
        [pending.id],
      );
      await expect(
        service.execute(request, { authorize: authorized, perform: increment }),
      ).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    expect(
      (
        await service.execute(request, {
          authorize: authorized,
          perform: increment,
        })
      ).replayed,
    ).toBe(false);
    expect(await version()).toBe(2);
  });

  it('retries actual MySQL deadlocks with stable receipt time and commits each operation once', async () => {
    const barrier = gate();
    let arrivals = 0;
    const attempts = [0, 0];
    const times: string[][] = [[], []];
    const jobs = [0, 1].map((index) =>
      service.execute(
        { ...command(), receivedAt: new Date('2026-11-08T01:02:03.456Z') },
        {
          authorize: authorized,
          perform: async (manager, context) => {
            attempts[index]++;
            times[index].push(context.receivedAt.toISOString());
            const first = index === 0 ? ids.employee : ids.otherEmployee;
            const second = index === 0 ? ids.otherEmployee : ids.employee;
            await manager.query(
              'SELECT id FROM employees WHERE id = ? FOR UPDATE',
              [first],
            );

            if (attempts[index] === 1) {
              arrivals++;

              if (arrivals === 2) {
                barrier.resolve();
              }

              await barrier.promise;
            }

            await manager.query(
              'SELECT id FROM employees WHERE id = ? FOR UPDATE',
              [second],
            );
            await manager.increment(
              EmployeeEntity,
              { id: first },
              'version',
              1,
            );
            return { status: 200, body: { employeeId: first } };
          },
        },
      ),
    );
    const results = await Promise.all(jobs);
    expect(results.every((result) => !result.replayed)).toBe(true);
    expect(attempts[0] + attempts[1]).toBe(3);
    expect(
      times.flat().every((value) => value === '2026-11-08T01:02:03.456Z'),
    ).toBe(true);
    expect(
      (
        await source.manager.findOneByOrFail(EmployeeEntity, {
          id: ids.employee,
        })
      ).version,
    ).toBe(2);
    expect(
      (
        await source.manager.findOneByOrFail(EmployeeEntity, {
          id: ids.otherEmployee,
        })
      ).version,
    ).toBe(2);
  });

  it('bounds contention retries and supports a one-connection pool', async () => {
    let attempts = 0;
    const times: number[] = [];
    await expect(
      service.execute(command(), {
        authorize: authorized,
        perform: async (manager, context) => {
          attempts++;
          times.push(context.receivedAt.getTime());
          await increment(manager);
          throw Object.assign(new Error('retry fixture'), {
            code: 'ER_LOCK_WAIT_TIMEOUT',
          });
        },
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_RETRY_EXHAUSTED' });
    expect(attempts).toBe(3);
    expect(new Set(times).size).toBe(1);
    expect(await version()).toBe(1);
    const config = loadRuntimeConfig();
    const single = createDataSource({
      ...config,
      database: { ...config.database, poolSize: 1 },
    });
    await single.initialize();
    try {
      const limited = new IdempotencyService(
        new IdempotencyRepository(single, clock),
        clock,
        config,
      );
      const request = command();
      expect(
        (
          await limited.execute(request, {
            authorize: authorized,
            perform: increment,
          })
        ).replayed,
      ).toBe(false);
      expect(
        (
          await limited.execute(request, {
            authorize: authorized,
            perform: increment,
          })
        ).replayed,
      ).toBe(true);
    } finally {
      await single.destroy();
    }
  });
});
