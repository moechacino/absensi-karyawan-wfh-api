import type { EntityManager } from 'typeorm';
import { LocalCommandRunner } from './local-command-runner.service';
import type { IdempotencyService } from './idempotency.service';
import type {
  IdempotencyCommand,
  IdempotencyHandlers,
} from './idempotency.types';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('LocalCommandRunner', () => {
  function setup() {
    const manager = {} as EntityManager;
    const body = {
      id,
      code: 'D',
      name: 'Division',
      description: null,
      status: 'ACTIVE',
      version: 1,
    };
    const command = {
      actorId: id,
      key: id,
      operation: 'createDivision' as const,
      input: {
        code: 'D',
        name: 'Division',
        status: 'ACTIVE',
        description: null,
      },
    };
    const idempotency = {
      execute: jest.fn(
        async (_command: IdempotencyCommand, handlers: IdempotencyHandlers) => {
          const result = await handlers.perform(manager, {
            receivedAt: new Date(),
          });

          return { status: result.status, body: result.body, replayed: false };
        },
      ),
    };
    const work = jest.fn(async (_manager: EntityManager) => body);
    const runner = new LocalCommandRunner(
      idempotency as unknown as IdempotencyService,
    );

    return {
      run: () => runner.run(command, work),
      runner,
      command,
      work,
      body,
      manager,
      idempotency,
    };
  }

  it('passes canonical controller input to the executor and supplies the business transaction', async () => {
    const { run, command, idempotency, body, work, manager } = setup();
    await expect(run()).resolves.toEqual({
      status: 201,
      body,
      replayed: false,
    });
    expect(idempotency.execute).toHaveBeenCalledWith(
      command,
      expect.anything(),
    );
    expect(work).toHaveBeenCalledWith(manager);
  });

  it('returns the completed response without running the business service', async () => {
    const { run, idempotency, work, body } = setup();
    idempotency.execute.mockResolvedValue({
      status: 201,
      body,
      replayed: true,
    });
    await expect(run()).resolves.toEqual({ status: 201, body, replayed: true });
    expect(work).not.toHaveBeenCalled();
  });

  it('rejects absent keys before executing work', async () => {
    const { run, command, idempotency, work } = setup();
    Reflect.deleteProperty(command, 'key');
    await expect(run()).rejects.toMatchObject({
      code: 'INVALID_IDEMPOTENCY_KEY',
    });
    expect(idempotency.execute).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it('propagates persistence failure unchanged', async () => {
    const { run, idempotency } = setup();
    const failure = new Error('Receipt write failed');
    const original = idempotency.execute.getMockImplementation()!;
    idempotency.execute.mockImplementation(async (...args) => {
      await original(...args);
      throw failure;
    });
    await expect(run()).rejects.toBe(failure);
  });

  it('preserves a business rejection unchanged', async () => {
    const { run, work } = setup();
    const failure = new Error('Domain rejection');
    work.mockRejectedValue(failure);
    await expect(run()).rejects.toBe(failure);
  });
});
