import type { StagedCheckInImage } from './rpc.files';
import type { IdempotencyCommand } from '../idempotency/idempotency.types';

export function checkInCommand(
  actorId: string,
  key: string,
  image: Pick<StagedCheckInImage, 'sha256'>,
  receivedAt: string,
): IdempotencyCommand {
  return {
    actorId,
    operation: 'checkIn',
    key,
    input: {},
    files: [{ field: 'photo', sha256: image.sha256 }],
    receivedAt: new Date(receivedAt),
  };
}
