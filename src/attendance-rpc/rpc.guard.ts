import { timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { TcpContext } from '@nestjs/microservices';

import { ProblemException } from '../http/problem';
import { AccessTokenService } from '../auth/access-token.service';
import type { Actor } from '../auth/access-token.service';

import { RPC_CONFIG, RPC_REQUEST_BYTES } from './rpc.config';
import type { RpcConfig } from './rpc.config';
import { rpcFault } from './rpc.fault';
import { ATTENDANCE_PATTERNS as patterns } from './rpc.contract';
import { isAttendanceWrite, requiresAttendanceHr } from './rpc.pattern-policy';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const actors = new WeakMap<TcpContext, Actor>();

export function rpcActor(context: TcpContext): Actor {
  const actor = actors.get(context);

  if (!actor) {
    throw rpcFault('RPC_UNAUTHORIZED');
  }

  return actor;
}

export function validateEnvelope(
  value: unknown,
  pattern: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw rpcFault('RPC_INVALID_ENVELOPE');
  }

  const data = value as Record<string, unknown>;

  if (data.version !== 1) {
    throw rpcFault('RPC_UNSUPPORTED_VERSION');
  }

  const allowed = [
    'version',
    'requestId',
    'serviceCredential',
    'accessToken',
    'input',
  ];

  if (isAttendanceWrite(pattern)) {
    allowed.push('idempotencyKey');
  }

  if (pattern === patterns.checkIn) {
    allowed.push('fullUploadReceivedAt', 'stagedImage');
  }

  if (
    Object.keys(data).some((key) => !allowed.includes(key)) ||
    Buffer.byteLength(JSON.stringify(data)) > RPC_REQUEST_BYTES ||
    typeof data.requestId !== 'string' ||
    !uuid.test(data.requestId) ||
    typeof data.serviceCredential !== 'string' ||
    Buffer.byteLength(data.serviceCredential) > 256 ||
    typeof data.accessToken !== 'string' ||
    !data.accessToken.length ||
    data.accessToken.length > 8192 ||
    !data.input ||
    typeof data.input !== 'object' ||
    Array.isArray(data.input) ||
    (isAttendanceWrite(pattern) &&
      (typeof data.idempotencyKey !== 'string' ||
        !uuid.test(data.idempotencyKey)))
  ) {
    throw rpcFault('RPC_INVALID_ENVELOPE');
  }

  // Task 024 extends validation before check-in/file/outcome handlers are registered.
  return data;
}

@Injectable()
export class RpcGuard implements CanActivate {
  constructor(
    @Inject(RPC_CONFIG) private readonly config: RpcConfig,
    private readonly tokens: AccessTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rpc = context.switchToRpc();
    const tcp = rpc.getContext<TcpContext>();
    const pattern = tcp.getPattern();
    const data = validateEnvelope(rpc.getData<unknown>(), pattern);

    const supplied = Buffer.from(data.serviceCredential as string);
    const expected = Buffer.from(this.config.serviceCredential);

    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw rpcFault('RPC_UNAUTHORIZED');
    }

    const actor = await this.tokens
      .verify(data.accessToken as string)
      .catch((error: unknown) => {
        if (
          error instanceof ProblemException &&
          (error.code === 'TOKEN_INVALID' || error.code === 'TOKEN_EXPIRED')
        ) {
          throw rpcFault(error.code);
        }

        throw rpcFault('RPC_INTERNAL_ERROR');
      });

    if (requiresAttendanceHr(pattern) && actor.role !== 'HRD') {
      throw rpcFault('RPC_FORBIDDEN');
    }

    actors.set(tcp, actor);
    return true;
  }
}
