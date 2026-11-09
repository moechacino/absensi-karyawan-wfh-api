import { randomUUID } from 'node:crypto';

import { NEVER, Observable, of, throwError } from 'rxjs';

import type { RpcConfig } from '../attendance-rpc/rpc.config';
import { ATTENDANCE_PATTERNS as patterns } from '../attendance-rpc/rpc.contract';
import { makeRpcFault } from '../attendance-rpc/rpc.fault';

import { AttendanceClient } from './attendance-client.service';
import type { RpcClient } from './rpc.client';

const config: RpcConfig = {
  host: '127.0.0.1',
  port: 4001,
  deadlineMs: 30,
  serviceCredential: 'client-test-only-credential-at-least-32-bytes',
};

const context = () => ({
  requestId: randomUUID(),
  accessToken: 'original-access-token',
  input: {},
});

function setup(result: Observable<unknown> = of({ items: [] })) {
  const send = jest.fn((_pattern: unknown, _payload: unknown) => result);
  const close = jest.fn();
  const factory = jest.fn(() => ({ send: send as RpcClient['send'], close }));
  const service = new AttendanceClient(config, factory);

  return { service, send, close, factory };
}

describe('AttendanceClient', () => {
  it('subscribes once, forwards original context and closes the socket', async () => {
    let subscriptions = 0;
    const result = { items: [] };
    const fixture = setup(
      new Observable((subscriber) => {
        subscriptions++;
        subscriber.next(result);
        subscriber.complete();
      }),
    );
    const request = context();

    await expect(
      fixture.service.call(patterns.timeZonesList, request),
    ).resolves.toBe(result);
    expect(subscriptions).toBe(1);
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledWith(patterns.timeZonesList, {
      ...request,
      version: 1,
      serviceCredential: config.serviceCredential,
    });
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it('forwards the original key and committed status/body/replay metadata unchanged', async () => {
    const result = { status: 200, body: { version: 2 }, replayed: true };
    const fixture = setup(of(result));
    const request = {
      ...context(),
      input: { attendanceId: randomUUID(), expectedVersion: 1 },
      idempotencyKey: randomUUID(),
    };

    await expect(
      fixture.service.call(patterns.checkOut, request),
    ).resolves.toBe(result);
    expect(fixture.send.mock.calls[0]).toEqual([
      patterns.checkOut,
      { ...request, version: 1, serviceCredential: config.serviceCredential },
    ]);
  });

  it.each([undefined, '', 'invalid-key'])(
    'rejects a malformed write key %p before opening a connection',
    async (idempotencyKey) => {
      const fixture = setup();
      const request = {
        ...context(),
        input: { attendanceId: randomUUID(), expectedVersion: 1 },
        idempotencyKey: idempotencyKey as string,
      };

      await expect(
        fixture.service.call(patterns.checkOut, request),
      ).rejects.toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
      expect(fixture.factory).not.toHaveBeenCalled();
    },
  );

  it('does not permit caller overrides of transport authentication or version', async () => {
    const fixture = setup();
    const request = {
      ...context(),
      serviceCredential: 'injected',
      version: 99,
      actorId: 'spoofed',
      idempotencyKey: randomUUID(),
    };

    await fixture.service.call(patterns.timeZonesList, request);
    expect(fixture.send.mock.calls[0]?.[1]).toEqual({
      version: 1,
      serviceCredential: config.serviceCredential,
      requestId: request.requestId,
      accessToken: request.accessToken,
      input: {},
    });
  });

  it.each(['read', 'write'] as const)(
    'bounds a pending %s by its deadline without retrying',
    async (operation) => {
      const fixture = setup(NEVER);
      const request = {
        ...context(),
        input: { attendanceId: randomUUID(), expectedVersion: 1 },
        idempotencyKey: randomUUID(),
      };
      const promise =
        operation === 'write'
          ? fixture.service.call(patterns.checkOut, request)
          : fixture.service.call(patterns.timeZonesList, context());

      await expect(promise).rejects.toMatchObject({
        status: 503,
        code:
          operation === 'write'
            ? 'ATTENDANCE_OUTCOME_UNKNOWN'
            : 'ATTENDANCE_SERVICE_TIMEOUT',
      });
      expect(fixture.send).toHaveBeenCalledTimes(1);
      expect(fixture.close).toHaveBeenCalledTimes(1);
    },
  );

  it('maps a confirmed business rejection without treating it as uncertain', async () => {
    const fixture = setup(
      throwError(() =>
        makeRpcFault('VERSION_CONFLICT', {
          details: { expectedVersion: 1, actualVersion: 2 },
        }),
      ),
    );

    await expect(
      fixture.service.call(patterns.checkOut, {
        ...context(),
        input: { attendanceId: randomUUID(), expectedVersion: 1 },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'VERSION_CONFLICT',
      publicOptions: { details: { expectedVersion: 1, actualVersion: 2 } },
    });
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it('closes active sockets during shutdown and rejects subsequent calls without sending', async () => {
    const fixture = setup(NEVER);
    const promise = fixture.service.call(patterns.timeZonesList, context());
    fixture.service.onModuleDestroy();

    expect(fixture.close).toHaveBeenCalled();
    await expect(
      fixture.service.call(patterns.timeZonesList, context()),
    ).rejects.toMatchObject({ code: 'ATTENDANCE_SERVICE_UNAVAILABLE' });
    await expect(promise).rejects.toMatchObject({
      code: 'ATTENDANCE_SERVICE_TIMEOUT',
    });
    expect(fixture.send).toHaveBeenCalledTimes(1);
  });
});
