import { TimeoutError } from 'rxjs';

import { ProblemException } from '../http/problem';
import { parseRpcFault } from '../attendance-rpc/rpc.fault-mapper';

export function attendanceUnavailable(
  write: boolean,
  timedOut = false,
): ProblemException {
  if (write) {
    return new ProblemException(
      503,
      'ATTENDANCE_OUTCOME_UNKNOWN',
      'Attendance command outcome unknown',
      {
        detail:
          'Keep the original idempotency key and input. Recover the result or retry with that same key; a timeout does not prove rollback.',
      },
    );
  }

  return new ProblemException(
    503,
    timedOut ? 'ATTENDANCE_SERVICE_TIMEOUT' : 'ATTENDANCE_SERVICE_UNAVAILABLE',
    timedOut
      ? 'Attendance service timed out'
      : 'Attendance service unavailable',
  );
}

export function rpcProblem(error: unknown, write: boolean): ProblemException {
  const fault = parseRpcFault(error);

  if (!fault) {
    return attendanceUnavailable(write, error instanceof TimeoutError);
  }

  if (fault.code === 'RPC_UNAUTHORIZED') {
    return attendanceUnavailable(false);
  }

  if (fault.kind === 'internal') {
    return write
      ? attendanceUnavailable(true)
      : new ProblemException(500, 'INTERNAL_ERROR', 'Internal server error');
  }

  if (fault.kind === 'protocol') {
    return new ProblemException(500, 'INTERNAL_ERROR', 'Internal server error');
  }

  const code =
    fault.code === 'RPC_VALIDATION_FAILED'
      ? 'VALIDATION_FAILED'
      : fault.code === 'RPC_FORBIDDEN'
        ? 'FORBIDDEN'
        : fault.code;

  return new ProblemException(fault.status, code, fault.message, {
    ...(fault.errors ? { errors: fault.errors } : {}),
    ...(fault.details ? { details: fault.details } : {}),
    ...(fault.retryAfter ? { retryAfter: fault.retryAfter } : {}),
  });
}
