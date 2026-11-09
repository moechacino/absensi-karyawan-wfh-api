import { Injectable, Logger } from '@nestjs/common';
import { AttendanceClient } from '../gateway-attendance/attendance-client.service';
import type { GatewayRpcContext } from '../gateway-attendance/rpc.context';
import type { StagedCheckInImage } from '../attendance-rpc/rpc.files';
import type { RpcCommandReply } from '../attendance-rpc/rpc.contract';
import type { Attendance } from '../attendance-rpc/rpc.responses';
import { ProblemException } from '../http/problem';
import { ImageService } from './image.service';
import { StorageService } from './storage.service';
import type { StagedImage, ImageInput } from './file.types';
import { stageImage } from './stage-image';

@Injectable()
export class RemoteImageService {
  private readonly logger = new Logger(RemoteImageService.name);

  constructor(
    private readonly attendance: AttendanceClient,
    private readonly images: ImageService,
    private readonly storage: StorageService,
  ) {}

  async checkIn(
    input: ImageInput,
    ownerEmployeeId: string,
    fullUploadReceivedAt: Date,
    key: string,
    context: GatewayRpcContext,
  ): Promise<RpcCommandReply<Attendance>> {
    // The receipt must have been pinned immediately after multipart completion.
    if (!Number.isFinite(fullUploadReceivedAt.getTime())) {
      throw new ProblemException(
        400,
        'INVALID_REQUEST',
        'Invalid upload receipt',
      );
    }

    const file = await stageImage(
      { input, ownerEmployeeId, purpose: 'CHECK_IN_PHOTO' },
      this.images,
      this.storage,
    );
    const stagedImage: StagedCheckInImage = {
      ...file,
      purpose: 'CHECK_IN_PHOTO',
      stagedAt: new Date().toISOString(),
    };
    let reply: RpcCommandReply<Attendance>;

    try {
      reply = await this.attendance.call('attendance.v1.check-in', {
        ...context,
        input: {},
        idempotencyKey: key,
        fullUploadReceivedAt: fullUploadReceivedAt.toISOString(),
        stagedImage,
      });
    } catch (error) {
      // Only explicit pre-commit rejections are safe. Missing receipts, 5xx and
      // an active key never prove rollback; retain bytes for manual recovery.
      if (
        error instanceof ProblemException &&
        error.getStatus() < 500 &&
        error.code !== 'OPERATION_IN_PROGRESS'
      ) {
        await this.cleanupConfirmed(file, context);
      }

      throw error;
    }

    await this.cleanupConfirmed(file, context);

    return reply;
  }

  private async cleanupConfirmed(
    file: StagedImage,
    context: GatewayRpcContext,
  ): Promise<void> {
    try {
      await this.attendance.call('attendance.v1.file-access', {
        ...context,
        input: { fileId: file.id },
      });
    } catch (error) {
      if (
        !(error instanceof ProblemException) ||
        error.code !== 'FILE_NOT_FOUND'
      ) {
        return;
      }

      try {
        await this.storage.delete(file.objectKey);
      } catch {
        this.logger.warn(
          'Unused attendance image cleanup failed; manual recovery may be required.',
        );
      }
    }
  }
}
