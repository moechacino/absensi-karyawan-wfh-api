import { RpcException } from '@nestjs/microservices';

import { ProblemException } from '../http/problem';

import { isRpcFaultCode, makeRpcFault, rpcFaultDefinitions } from './rpc.fault';
import type { RpcFault, RpcFaultOptions, RpcFieldError } from './rpc.fault';

const fieldPath =
  /^(opensMinutesBeforeStart|expectedVersion|workingDays|startTime|endTime|endDayOffset|timeZone|effectiveFrom|year|upsert|remove|date|name|category|page|pageSize|q|atDate|from|to|attendanceId|divisionId|status|punctuality)(\.(\d{1,3}|date|name|category))*$/;

export function safeFaultOptions(value: unknown): RpcFaultOptions {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const options = value as Record<string, unknown>;
  const result: RpcFaultOptions = {};

  if (Array.isArray(options.errors)) {
    result.errors = options.errors
      .slice(0, 32)
      .flatMap((error: unknown): RpcFieldError[] => {
        if (
          !error ||
          typeof error !== 'object' ||
          !('field' in error) ||
          typeof error.field !== 'string' ||
          error.field.length > 160 ||
          !fieldPath.test(error.field)
        ) {
          return [];
        }

        return [
          {
            field: error.field,
            code:
              'code' in error && error.code === 'UNKNOWN_FIELD'
                ? 'UNKNOWN_FIELD'
                : 'INVALID_VALUE',
            message: 'Use the documented field format.',
          },
        ];
      });
  }

  if (options.details && typeof options.details === 'object') {
    const details: NonNullable<RpcFaultOptions['details']> = {};

    for (const key of ['expectedVersion', 'actualVersion'] as const) {
      const number = (options.details as Record<string, unknown>)[key];

      if (
        typeof number === 'number' &&
        Number.isSafeInteger(number) &&
        number >= 0
      ) {
        details[key] = number;
      }
    }

    if (Object.keys(details).length) {
      result.details = details;
    }
  }

  if (
    typeof options.retryAfter === 'number' &&
    Number.isInteger(options.retryAfter) &&
    options.retryAfter > 0 &&
    options.retryAfter <= 60
  ) {
    result.retryAfter = options.retryAfter;
  }

  return result;
}

export function parseRpcFault(value: unknown): RpcFault | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('code' in value) ||
    !isRpcFaultCode(value.code)
  ) {
    return;
  }

  const definition = rpcFaultDefinitions[value.code];

  if (
    !('version' in value) ||
    value.version !== 1 ||
    !('kind' in value) ||
    value.kind !== definition.kind ||
    !('status' in value) ||
    value.status !== definition.status
  ) {
    return;
  }

  return makeRpcFault(value.code, safeFaultOptions(value));
}

export function toRpcFault(error: unknown): RpcFault {
  if (error instanceof ProblemException && isRpcFaultCode(error.code)) {
    const definition = rpcFaultDefinitions[error.code];

    if (definition.status === error.getStatus()) {
      return makeRpcFault(error.code, safeFaultOptions(error.publicOptions));
    }
  }

  if (error instanceof RpcException) {
    const fault = parseRpcFault(error.getError());

    if (fault) {
      return fault;
    }
  }

  return makeRpcFault('RPC_INTERNAL_ERROR');
}
