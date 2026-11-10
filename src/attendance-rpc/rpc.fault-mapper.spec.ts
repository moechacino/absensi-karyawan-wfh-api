import { RpcException } from '@nestjs/microservices';
import { TimeoutError } from 'rxjs';

import { ProblemException } from '../http/problem';
import { rpcProblem } from '../gateway-attendance/rpc.problem';

import { makeRpcFault, rpcFaultDefinitions } from './rpc.fault';
import type { RpcFaultCode } from './rpc.fault';
import { parseRpcFault, toRpcFault } from './rpc.fault-mapper';

const secret = 'private-SQL-JWT-path-marker';

describe('typed RPC fault mapping', () => {
  it.each(Object.keys(rpcFaultDefinitions) as RpcFaultCode[])(
    'round-trips a declared fault %s with a canonical message',
    (code) => {
      const fault = makeRpcFault(code);

      expect(parseRpcFault(fault)).toEqual(fault);
      expect(toRpcFault(new RpcException(fault))).toEqual(fault);
    },
  );

  it('transports missed check-out as a completed 409 business failure', () => {
    expect(rpcProblem(makeRpcFault('MISSED_CHECK_OUT'), true)).toMatchObject({
      status: 409,
      code: 'MISSED_CHECK_OUT',
    });
  });

  it('maps existing helper failures and strips arbitrary exception messages and details', () => {
    const error = new ProblemException(409, 'VERSION_CONFLICT', secret, {
      detail: secret,
      details: { expectedVersion: 1, actualVersion: 2, sql: secret },
      errors: [
        { field: 'expectedVersion', code: secret, message: secret },
        { field: 'passwordHash', code: secret, message: secret },
      ],
      retryAfter: 1,
    });
    const fault = toRpcFault(error);

    expect(fault).toEqual(
      makeRpcFault('VERSION_CONFLICT', {
        details: { expectedVersion: 1, actualVersion: 2 },
        errors: [
          {
            field: 'expectedVersion',
            code: 'INVALID_VALUE',
            message: 'Use the documented field format.',
          },
        ],
        retryAfter: 1,
      }),
    );
    expect(JSON.stringify(fault)).not.toContain(secret);
  });

  it.each([
    new Error(secret),
    new RpcException(secret),
    new ProblemException(500, 'VERSION_CONFLICT', secret),
    new ProblemException(409, 'UNKNOWN_CODE', secret),
  ])('sanitizes unknown or inconsistent exceptions', (error) => {
    expect(toRpcFault(error)).toEqual(makeRpcFault('RPC_INTERNAL_ERROR'));
  });

  it.each([
    { ...makeRpcFault('VERSION_CONFLICT'), status: 200 },
    { ...makeRpcFault('TOKEN_EXPIRED'), kind: 'business' },
    { version: 2, code: 'TOKEN_EXPIRED' },
    secret,
    null,
  ])('does not trust malformed wire faults', (fault) => {
    expect(parseRpcFault(fault)).toBeUndefined();
  });

  it.each([false, true])(
    'keeps completed business rejections distinct from transport loss (write=%s)',
    (write) => {
      expect(
        rpcProblem(makeRpcFault('IDEMPOTENCY_KEY_REUSED'), write),
      ).toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
      expect(rpcProblem(new Error(secret), write)).toMatchObject({
        status: 503,
        code: write
          ? 'ATTENDANCE_OUTCOME_UNKNOWN'
          : 'ATTENDANCE_SERVICE_UNAVAILABLE',
      });
      expect(rpcProblem(new TimeoutError(), write)).toMatchObject({
        status: 503,
        code: write
          ? 'ATTENDANCE_OUTCOME_UNKNOWN'
          : 'ATTENDANCE_SERVICE_TIMEOUT',
      });
    },
  );

  it('preserves token expiry and bounded retry guidance', () => {
    expect(rpcProblem(makeRpcFault('TOKEN_EXPIRED'), false)).toMatchObject({
      status: 401,
      code: 'TOKEN_EXPIRED',
    });
    expect(
      rpcProblem(
        toRpcFault(
          new ProblemException(409, 'OPERATION_IN_PROGRESS', secret, {
            retryAfter: 1,
          }),
        ),
        true,
      ),
    ).toMatchObject({
      status: 409,
      code: 'OPERATION_IN_PROGRESS',
      publicOptions: { retryAfter: 1 },
    });
  });

  it('treats an internal write failure as uncertain and a credential denial as service unavailable', () => {
    expect(rpcProblem(makeRpcFault('RPC_INTERNAL_ERROR'), true)).toMatchObject({
      code: 'ATTENDANCE_OUTCOME_UNKNOWN',
    });
    expect(rpcProblem(makeRpcFault('RPC_UNAUTHORIZED'), true)).toMatchObject({
      code: 'ATTENDANCE_SERVICE_UNAVAILABLE',
    });
  });
});
