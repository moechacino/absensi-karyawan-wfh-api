import { ProblemException } from '../http/problem';

export function inProgress(): ProblemException {
  return new ProblemException(
    409,
    'OPERATION_IN_PROGRESS',
    'Operation in progress',
    { detail: 'Retry with the same idempotency key.', retryAfter: 1 },
  );
}

export function mysqlErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return;
  }

  if ('driverError' in error) {
    return mysqlErrorCode(error.driverError);
  }

  return 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export function isRetryableTransactionError(error: unknown): boolean {
  const code = mysqlErrorCode(error);

  return code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT';
}
