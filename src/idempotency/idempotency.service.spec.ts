import type { EntityManager } from 'typeorm';
import { IdempotencyOperationEntity } from '../database/entities';
import { ProblemException } from '../http/problem';
import { parseRuntimeConfig } from '../runtime/runtime.config';
import { fingerprint } from './fingerprint';
import { IdempotencyService } from './idempotency.service';
import type { IdempotencyRepository } from './idempotency.repository';
import type { PreparedRequest } from './idempotency.request';
import type {
  IdempotencyCommand,
  IdempotencyHandlers,
  StoredResult,
} from './idempotency.types';

const now = new Date('2026-11-08T01:00:00Z');
const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const key = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const resourceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const config = parseRuntimeConfig({
  NODE_ENV: 'test',
  DB_HOST: '127.0.0.1',
  DB_NAME: 'unused_test',
  DB_USERNAME: 'unused',
  DB_PASSWORD: 'unit-test-only',
  JWT_SECRET: 'unit-test-only-secret-of-at-least-32-bytes',
  JWT_ISSUER: 'unit-test',
  JWT_AUDIENCE: 'unit-test',
  STORAGE_ROOT: '../private-files',
});

describe('IdempotencyService', () => {
  // Opaque transaction identity: no DataSource, repository implementation or SQL runs here.
  const manager = Object.freeze({}) as EntityManager;
  const clock = { now: () => new Date(now) };

  function setup() {
    const repository = {
      runExclusive: jest.fn(
        async (
          _request: PreparedRequest,
          work: (manager: EntityManager) => Promise<unknown>,
        ) => work(manager),
      ),
      findForUpdate: jest
        .fn<
          Promise<IdempotencyOperationEntity | null>,
          [EntityManager, PreparedRequest]
        >()
        .mockResolvedValue(null),
      remove: jest
        .fn<Promise<void>, [EntityManager, string]>()
        .mockResolvedValue(undefined),
      saveCompleted: jest
        .fn<Promise<void>, Parameters<IdempotencyRepository['saveCompleted']>>()
        .mockResolvedValue(undefined),
      cleanupExpired: jest.fn<Promise<number>, [number]>(),
    };
    const service = new IdempotencyService(
      repository as unknown as IdempotencyRepository,
      clock,
      config,
    );
    const command: IdempotencyCommand = {
      actorId,
      operation: 'createDivision',
      key,
      input: { name: 'Engineering', expectedVersion: 1 },
    };
    const result: StoredResult = {
      status: 201,
      body: { divisionId: resourceId, version: 2 },
      resourceId,
    };
    const handlers = {
      authorize: jest.fn<Promise<void>, [EntityManager]>().mockResolvedValue(),
      perform: jest
        .fn<Promise<StoredResult>, Parameters<IdempotencyHandlers['perform']>>()
        .mockResolvedValue(result),
    };

    return { repository, service, command, result, handlers };
  }

  function completed(command: IdempotencyCommand, result: StoredResult) {
    return Object.assign(new IdempotencyOperationEntity(), {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      actorId,
      routeScope: command.operation,
      idempotencyKey: key,
      fingerprint: fingerprint(
        command.input,
        command.files,
        command.resourceId,
      ),
      state: 'COMPLETED' as const,
      httpStatus: result.status,
      result: result.body,
      resourceId: result.resourceId ?? null,
      leaseExpiresAt: null,
      expiresAt: new Date(now.getTime() + 86400_000),
    });
  }

  it('authorizes and saves a fresh public result with the same transaction manager', async () => {
    const { service, repository, command, handlers, result } = setup();
    command.actorId = actorId.toUpperCase();
    command.key = key.toUpperCase();

    await expect(service.execute(command, handlers)).resolves.toEqual({
      status: result.status,
      body: result.body,
      replayed: false,
    });
    expect(handlers.authorize).toHaveBeenCalledWith(manager);
    expect(handlers.perform).toHaveBeenCalledWith(manager, { receivedAt: now });
    expect(repository.saveCompleted).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ actorId, key, receivedAt: now }),
      result,
      config.policy.idempotencyRetentionSeconds,
    );
  });

  it('replays the original result without rechecking the version or repeating the mutation', async () => {
    const { service, repository, command, handlers, result } = setup();
    repository.findForUpdate.mockResolvedValue(completed(command, result));
    handlers.perform.mockRejectedValue(new Error('Current version changed'));

    await expect(service.execute(command, handlers)).resolves.toEqual({
      status: 201,
      body: result.body,
      replayed: true,
    });
    expect(handlers.authorize).toHaveBeenCalledWith(manager);
    expect(handlers.perform).not.toHaveBeenCalled();
    expect(repository.saveCompleted).not.toHaveBeenCalled();
  });

  it('rejects changed input under an unexpired key without mutating or overwriting its receipt', async () => {
    const { service, repository, command, handlers, result } = setup();
    repository.findForUpdate.mockResolvedValue(completed(command, result));
    command.input.name = 'Different division';

    await expect(service.execute(command, handlers)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(handlers.perform).not.toHaveBeenCalled();
    expect(repository.remove).not.toHaveBeenCalled();
    expect(repository.saveCompleted).not.toHaveBeenCalled();
  });

  it('rejects unauthorized replay before reading or returning cached data', async () => {
    const { service, repository, command, handlers, result } = setup();
    repository.findForUpdate.mockResolvedValue(completed(command, result));
    const denied = new ProblemException(403, 'FORBIDDEN', 'Forbidden');
    handlers.authorize.mockRejectedValue(denied);

    await expect(service.execute(command, handlers)).rejects.toBe(denied);
    expect(repository.findForUpdate).not.toHaveBeenCalled();
    expect(handlers.perform).not.toHaveBeenCalled();
    expect(repository.saveCompleted).not.toHaveBeenCalled();
  });

  it('runs fresh version validation at the retention boundary instead of replaying expired success', async () => {
    const { service, repository, command, handlers, result } = setup();
    const previous = completed(command, result);
    previous.expiresAt = new Date(now);
    repository.findForUpdate.mockResolvedValue(previous);
    command.input.name = 'Changed after expiry';
    const stale = new ProblemException(
      409,
      'VERSION_CONFLICT',
      'Stale version',
    );
    handlers.perform.mockRejectedValue(stale);

    await expect(service.execute(command, handlers)).rejects.toBe(stale);
    expect(repository.remove).toHaveBeenCalledWith(manager, previous.id);
    expect(handlers.perform).toHaveBeenCalledTimes(1);
    expect(repository.saveCompleted).not.toHaveBeenCalled();
  });

  it.each([null, new Date(now.getTime() + 1000)])(
    'refuses pending work whose lease has not expired: %p',
    async (leaseExpiresAt) => {
      const { service, repository, command, handlers, result } = setup();
      repository.findForUpdate.mockResolvedValue(
        Object.assign(completed(command, result), {
          state: 'IN_PROGRESS',
          leaseExpiresAt,
        }),
      );

      await expect(service.execute(command, handlers)).rejects.toMatchObject({
        code: 'OPERATION_IN_PROGRESS',
        publicOptions: { retryAfter: 1 },
      });
      expect(handlers.perform).not.toHaveBeenCalled();
      expect(repository.remove).not.toHaveBeenCalled();
    },
  );

  it('recovers an expired pending receipt after repository row ownership is granted', async () => {
    const { service, repository, command, handlers, result } = setup();
    const previous = Object.assign(completed(command, result), {
      state: 'IN_PROGRESS' as const,
      leaseExpiresAt: new Date(now),
    }) as IdempotencyOperationEntity;
    repository.findForUpdate.mockResolvedValue(previous);

    await expect(service.execute(command, handlers)).resolves.toMatchObject({
      replayed: false,
    });
    expect(repository.remove).toHaveBeenCalledWith(manager, previous.id);
    expect(handlers.perform).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 199 },
    { status: 300 },
    { status: 201.5 },
    { resourceId: 'invalid-uuid' },
    { body: { nested: { accessToken: 'must-not-be-cached' } } },
  ])(
    'refuses to save an invalid or secret-bearing result: %p',
    async (override) => {
      const { service, repository, command, handlers, result } = setup();
      handlers.perform.mockResolvedValue({ ...result, ...override });

      await expect(service.execute(command, handlers)).rejects.toThrow();
      expect(repository.saveCompleted).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'projects current employee credentials while keeping the receipt nonsecret (replay=%p)',
    async (replayed) => {
      const { service, repository, command, handlers } = setup();
      command.operation = 'createEmployee';
      const receipt = { status: 201, body: { employeeId: resourceId } };
      handlers.perform.mockResolvedValue(receipt);
      const response = {
        employeeId: resourceId,
        initialPassword: 'current-only',
      };
      const present = jest.fn().mockResolvedValue(response);

      if (replayed) {
        repository.findForUpdate.mockResolvedValue(completed(command, receipt));
      }

      await expect(
        service.execute(command, { ...handlers, present }),
      ).resolves.toEqual({ status: 201, body: response, replayed });
      expect(present).toHaveBeenCalledWith(manager, receipt, replayed);

      if (replayed) {
        expect(handlers.perform).not.toHaveBeenCalled();
        expect(repository.saveCompleted).not.toHaveBeenCalled();
      } else {
        expect(repository.saveCompleted).toHaveBeenCalledWith(
          manager,
          expect.anything(),
          receipt,
          config.policy.idempotencyRetentionSeconds,
        );
      }
    },
  );

  it('preserves employee-create replay when initial credentials are no longer available', async () => {
    const { service, repository, command, handlers } = setup();
    command.operation = 'createEmployee';
    repository.findForUpdate.mockResolvedValue(
      completed(command, { status: 201, body: { employeeId: resourceId } }),
    );
    const unavailable = new ProblemException(
      409,
      'INITIAL_CREDENTIALS_UNAVAILABLE',
      'Initial credentials unavailable',
    );
    const present = jest.fn().mockRejectedValue(unavailable);

    await expect(
      service.execute(command, { ...handlers, present }),
    ).rejects.toBe(unavailable);
    expect(handlers.perform).not.toHaveBeenCalled();
    expect(repository.remove).not.toHaveBeenCalled();
    expect(repository.saveCompleted).not.toHaveBeenCalled();
  });

  it('refuses extra fields in an employee-create receipt even when they are public', async () => {
    const { service, repository, command, handlers } = setup();
    command.operation = 'createEmployee';
    handlers.perform.mockResolvedValue({
      status: 201,
      body: { employeeId: resourceId, fullName: 'Extra field' },
    });
    const present = jest.fn();

    await expect(
      service.execute(command, { ...handlers, present }),
    ).rejects.toThrow('only employeeId');
    expect(present).not.toHaveBeenCalled();
    expect(repository.saveCompleted).not.toHaveBeenCalled();
  });

  it.each([
    { key: 'not-a-uuid' },
    { actorId: 'not-a-uuid' },
    { operation: 'updateEmployee' as const },
    { operation: 'checkOut' as const },
    { operation: 'checkIn' as const },
    { receivedAt: new Date(NaN) },
    { input: { value: Infinity } },
  ])(
    'rejects invalid commands before repository coordination: %p',
    async (override) => {
      const { service, repository, command, handlers } = setup();

      await expect(
        service.execute({ ...command, ...override }, handlers),
      ).rejects.toBeInstanceOf(ProblemException);
      expect(repository.runExclusive).not.toHaveBeenCalled();
      expect(handlers.authorize).not.toHaveBeenCalled();
      expect(handlers.perform).not.toHaveBeenCalled();
    },
  );

  it('requires employee projection and disallows changing other operations through projection', async () => {
    const { service, repository, command, handlers } = setup();

    await expect(
      service.execute({ ...command, operation: 'createEmployee' }, handlers),
    ).rejects.toThrow('requires a current-credential response mapper');
    await expect(
      service.execute(command, { ...handlers, present: jest.fn() }),
    ).rejects.toThrow('Only employee creation');
    expect(repository.runExclusive).not.toHaveBeenCalled();
  });

  it('passes authoritative upload receipt time rather than the processing clock to check-in', async () => {
    const { service, command, handlers } = setup();
    const receivedAt = new Date(now.getTime() - 30_000);

    await service.execute(
      { ...command, operation: 'checkIn', receivedAt },
      handlers,
    );
    expect(handlers.perform).toHaveBeenCalledWith(manager, { receivedAt });
    expect(handlers.perform.mock.calls[0][1].receivedAt).not.toBe(receivedAt);
  });
});
