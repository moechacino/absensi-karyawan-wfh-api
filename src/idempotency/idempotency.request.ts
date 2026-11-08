import { ProblemException } from '../http/problem';
import { fingerprint } from './fingerprint';
import { operations, uuid } from './idempotency.types';
import type {
  IdempotencyCommand,
  IdempotencyHandlers,
} from './idempotency.types';
import type { Clock } from '../runtime/clock';

export function prepareRequest(
  command: IdempotencyCommand,
  handlers: IdempotencyHandlers,
  clock: Clock,
) {
  if (
    !uuid.test(command.actorId) ||
    !uuid.test(command.key) ||
    !operations.includes(command.operation) ||
    (command.resourceId !== undefined && !uuid.test(command.resourceId)) ||
    (['updateEmployee', 'checkOut'].includes(command.operation) &&
      !command.resourceId)
  ) {
    throw new ProblemException(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Invalid idempotency request',
    );
  }

  if (command.operation === 'createEmployee' && !handlers.present) {
    throw new Error(
      'Employee creation requires a current-credential response mapper.',
    );
  }

  if (
    command.receivedAt !== undefined &&
    !(command.receivedAt instanceof Date)
  ) {
    throw new ProblemException(400, 'INVALID_REQUEST', 'Invalid receipt time');
  }

  if (command.operation !== 'createEmployee' && handlers.present) {
    throw new Error('Only employee creation may reconstruct a cached receipt.');
  }

  const receivedAt = (command.receivedAt ?? clock.now()).getTime();

  if (
    !Number.isFinite(receivedAt) ||
    (command.operation === 'checkIn' && !command.receivedAt)
  ) {
    throw new ProblemException(
      400,
      'INVALID_REQUEST',
      'A valid full-upload receipt time is required',
    );
  }

  let hash: string;

  try {
    hash = fingerprint(command.input, command.files, command.resourceId);
  } catch {
    throw new ProblemException(
      400,
      'INVALID_REQUEST',
      'Invalid idempotency input',
    );
  }

  return {
    actorId: command.actorId.toLowerCase(),
    operation: command.operation,
    key: command.key.toLowerCase(),
    hash,
    receivedAt: new Date(receivedAt),
  };
}

export type PreparedRequest = ReturnType<typeof prepareRequest>;
