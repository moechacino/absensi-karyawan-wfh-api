import { RpcException } from '@nestjs/microservices';

export const rpcFaultDefinitions = {
  RPC_INVALID_ENVELOPE: {
    kind: 'protocol',
    status: 500,
    message: 'Attendance RPC request failed.',
  },
  RPC_UNSUPPORTED_VERSION: {
    kind: 'protocol',
    status: 500,
    message: 'Attendance RPC request failed.',
  },
  RPC_UNAUTHORIZED: {
    kind: 'protocol',
    status: 503,
    message: 'Attendance RPC request failed.',
  },
  RPC_FORBIDDEN: {
    kind: 'authorization',
    status: 403,
    message: 'HRD permission required',
  },
  RPC_VALIDATION_FAILED: {
    kind: 'validation',
    status: 400,
    message: 'Validation failed',
  },
  RPC_RESPONSE_TOO_LARGE: {
    kind: 'internal',
    status: 500,
    message: 'Attendance RPC request failed.',
  },
  RPC_INTERNAL_ERROR: {
    kind: 'internal',
    status: 500,
    message: 'Attendance RPC request failed.',
  },
  TOKEN_INVALID: {
    kind: 'authentication',
    status: 401,
    message: 'Access token invalid or expired',
  },
  TOKEN_EXPIRED: {
    kind: 'authentication',
    status: 401,
    message: 'Access token invalid or expired',
  },
  FORBIDDEN: { kind: 'authorization', status: 403, message: 'Access denied' },
  NOT_FOUND: { kind: 'business', status: 404, message: 'Resource not found' },
  FILE_NOT_FOUND: { kind: 'business', status: 404, message: 'File not found' },
  INVALID_REQUEST: {
    kind: 'validation',
    status: 400,
    message: 'Invalid request',
  },
  VALIDATION_FAILED: {
    kind: 'validation',
    status: 400,
    message: 'Validation failed',
  },
  INVALID_IDEMPOTENCY_KEY: {
    kind: 'validation',
    status: 400,
    message: 'A UUID idempotency key is required',
  },
  VERSION_CONFLICT: {
    kind: 'business',
    status: 409,
    message: 'Version conflict',
  },
  OPERATION_IN_PROGRESS: {
    kind: 'business',
    status: 409,
    message: 'Operation in progress',
  },
  IDEMPOTENCY_KEY_REUSED: {
    kind: 'business',
    status: 422,
    message: 'Idempotency key reused',
  },
  OPERATION_RETRY_EXHAUSTED: {
    kind: 'business',
    status: 503,
    message: 'Operation temporarily busy',
  },
  SERVICE_UNAVAILABLE: {
    kind: 'business',
    status: 503,
    message: 'Operation coordination unavailable',
  },
  PAST_DATE_IMMUTABLE: {
    kind: 'business',
    status: 422,
    message: 'Past dates cannot be changed',
  },
  IMPACT_STALE: {
    kind: 'business',
    status: 409,
    message: 'Configuration changed; review current state',
  },
  INVALID_WORKING_DAYS: {
    kind: 'business',
    status: 422,
    message: 'Invalid working days',
  },
  INVALID_DURATION: {
    kind: 'business',
    status: 422,
    message: 'Invalid work duration',
  },
  TIME_ZONE_INVALID: {
    kind: 'business',
    status: 422,
    message: 'Unsupported time zone',
  },
  INVALID_LOCAL_TIME: {
    kind: 'business',
    status: 422,
    message: 'Local time is ambiguous or does not exist',
  },
  HOLIDAY_BATCH_INVALID: {
    kind: 'business',
    status: 422,
    message: 'Invalid holiday batch',
  },
  DUPLICATE_DATE: {
    kind: 'business',
    status: 422,
    message: 'Duplicate holiday date',
  },
  CHECK_IN_TOO_EARLY: {
    kind: 'business',
    status: 409,
    message: 'Check-in is not open yet',
  },
  CHECK_IN_WINDOW_CLOSED: {
    kind: 'business',
    status: 409,
    message: 'Check-in window is closed',
  },
  ATTENDANCE_NOT_REQUIRED: {
    kind: 'business',
    status: 409,
    message: 'Attendance is not required',
  },
  SCHEDULE_NOT_CONFIGURED: {
    kind: 'business',
    status: 409,
    message: 'Work schedule is not configured',
  },
  CHECK_IN_CONTEXT_STALE: {
    kind: 'business',
    status: 409,
    message: 'Attendance context changed',
  },
  ALREADY_CHECKED_IN: {
    kind: 'business',
    status: 409,
    message: 'Already checked in',
  },
  ALREADY_CHECKED_OUT: {
    kind: 'business',
    status: 409,
    message: 'Already checked out',
  },
} as const;

export type RpcFaultCode = keyof typeof rpcFaultDefinitions;

export interface RpcFieldError {
  field: string;
  code: 'INVALID_VALUE' | 'UNKNOWN_FIELD';
  message: string;
}

export interface RpcFaultOptions {
  errors?: RpcFieldError[];
  details?: { expectedVersion?: number; actualVersion?: number };
  retryAfter?: number;
}

export type RpcFault = {
  [Code in RpcFaultCode]: {
    version: 1;
    code: Code;
  } & (typeof rpcFaultDefinitions)[Code] &
    RpcFaultOptions;
}[RpcFaultCode];

export function isRpcFaultCode(code: unknown): code is RpcFaultCode {
  return typeof code === 'string' && Object.hasOwn(rpcFaultDefinitions, code);
}

export function makeRpcFault(
  code: RpcFaultCode,
  options: RpcFaultOptions = {},
): RpcFault {
  return {
    version: 1,
    code,
    ...rpcFaultDefinitions[code],
    ...options,
  } as RpcFault;
}

export function rpcFault(
  code: RpcFaultCode,
  options: RpcFaultOptions = {},
): RpcException {
  return new RpcException(makeRpcFault(code, options));
}
