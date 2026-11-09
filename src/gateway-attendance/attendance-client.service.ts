import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { defer, firstValueFrom, timeout } from 'rxjs';

import { RPC_CONFIG, RPC_REQUEST_BYTES } from '../attendance-rpc/rpc.config';
import type { RpcConfig } from '../attendance-rpc/rpc.config';
import { ATTENDANCE_PATTERNS } from '../attendance-rpc/rpc.contract';
import type { AttendanceRpcOperations } from '../attendance-rpc/rpc.contract';
import { isAttendanceWrite } from '../attendance-rpc/rpc.pattern-policy';
import { uuid } from '../idempotency/idempotency.types';
import { ProblemException } from '../http/problem';

import { RPC_CLIENT_FACTORY } from './rpc.client';
import type { RpcClient, RpcClientFactory } from './rpc.client';
import { rpcProblem, attendanceUnavailable } from './rpc.problem';

export type AttendanceRpcPattern = keyof AttendanceRpcOperations;
export type GatewayRpcRequest<Pattern extends AttendanceRpcPattern> = Omit<
  AttendanceRpcOperations[Pattern]['request'],
  'serviceCredential' | 'version'
>;

@Injectable()
export class AttendanceClient implements OnModuleDestroy {
  private readonly clients = new Set<RpcClient>();
  private closed = false;

  constructor(
    @Inject(RPC_CONFIG) private readonly config: RpcConfig,
    @Inject(RPC_CLIENT_FACTORY) private readonly createClient: RpcClientFactory,
  ) {}

  async call<Pattern extends AttendanceRpcPattern>(
    pattern: Pattern,
    request: GatewayRpcRequest<Pattern>,
  ): Promise<AttendanceRpcOperations[Pattern]['response']> {
    const write = isAttendanceWrite(pattern);

    if (!Object.values(ATTENDANCE_PATTERNS).includes(pattern)) {
      throw new ProblemException(
        500,
        'INTERNAL_ERROR',
        'Internal server error',
      );
    }

    if (
      write &&
      (!('idempotencyKey' in request) ||
        typeof request.idempotencyKey !== 'string' ||
        !uuid.test(request.idempotencyKey))
    ) {
      throw new ProblemException(
        400,
        'INVALID_IDEMPOTENCY_KEY',
        'A UUID idempotency key is required',
      );
    }

    if (
      !uuid.test(request.requestId) ||
      !request.accessToken ||
      request.accessToken.length > 4096
    ) {
      throw new ProblemException(
        500,
        'INTERNAL_ERROR',
        'Invalid gateway RPC context',
      );
    }

    // Pick transport fields explicitly; caller input was already validated by HTTP.
    const envelope = {
      version: 1,
      requestId: request.requestId,
      serviceCredential: this.config.serviceCredential,
      accessToken: request.accessToken,
      input: request.input,
      ...(write && 'idempotencyKey' in request
        ? { idempotencyKey: request.idempotencyKey }
        : {}),
    };

    if (
      Buffer.byteLength(JSON.stringify(envelope)) >
      RPC_REQUEST_BYTES - 1024
    ) {
      throw new ProblemException(
        413,
        'PAYLOAD_TOO_LARGE',
        'RPC request is too large',
      );
    }

    if (this.closed) {
      throw attendanceUnavailable(false);
    }

    const client = this.createClient();
    this.clients.add(client);

    try {
      // One subscription, one send, no retry. The deadline includes connecting.
      return await firstValueFrom(
        defer(() =>
          client.send<AttendanceRpcOperations[Pattern]['response']>(
            pattern,
            envelope,
          ),
        ).pipe(timeout({ first: this.config.deadlineMs })),
      );
    } catch (error) {
      throw rpcProblem(error, write);
    } finally {
      this.clients.delete(client);
      client.close();
    }
  }

  onModuleDestroy(): void {
    this.closed = true;

    for (const client of this.clients) {
      client.close();
    }

    this.clients.clear();
  }
}
