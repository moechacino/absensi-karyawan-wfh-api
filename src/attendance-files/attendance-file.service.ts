import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { Actor } from '../auth/access-token.service';
import type {
  CommandOutcome,
  CommandOutcomeInput,
  FileReadDescriptor,
  StagedCheckInImage,
} from '../attendance-rpc/rpc.files';
import { ProblemException } from '../http/problem';
import { publicReceipt } from '../idempotency/fingerprint';
import { StorageService } from '../files/storage.service';
import { ImageService } from '../files/image.service';
import { AttendanceFileRepository } from './attendance-file.repository';

@Injectable()
export class AttendanceFileService {
  constructor(
    private readonly repository: AttendanceFileRepository,
    private readonly storage: StorageService,
    private readonly images: ImageService,
  ) {}

  // Called after RPC DTO validation, before opening the command's SQL transaction.
  async verify(
    image: StagedCheckInImage,
    actor: Actor,
    receivedAt: string,
  ): Promise<void> {
    const stagedAt = new Date(image.stagedAt);
    const receipt = new Date(receivedAt);

    if (
      image.ownerEmployeeId !== actor.id ||
      image.purpose !== 'CHECK_IN_PHOTO' ||
      !Number.isFinite(stagedAt.getTime()) ||
      stagedAt.toISOString() !== image.stagedAt ||
      !Number.isFinite(receipt.getTime()) ||
      receipt.toISOString() !== receivedAt ||
      receipt > stagedAt ||
      stagedAt.getTime() > Date.now() + 5000
    ) {
      throw new ProblemException(
        400,
        'INVALID_REQUEST',
        'Invalid staged image',
      );
    }

    const extension = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    }[image.mimeType];

    if (image.objectKey !== `${image.id}.${extension}`) {
      throw new ProblemException(422, 'INVALID_FILE', 'Invalid staged image');
    }

    const bytes = await this.storage.read(image.objectKey, image.sizeBytes);
    const actual = await this.images.validate({
      bytes,
      mimeType: image.mimeType,
      fileName: image.fileName,
    });

    if (actual.sha256 !== image.sha256 || actual.fileName !== image.fileName) {
      throw new ProblemException(422, 'INVALID_FILE', 'Invalid staged image');
    }
  }

  attach(manager: EntityManager, image: StagedCheckInImage): Promise<void> {
    // Parent attendance and its receipt MUST be written with this same manager.
    return this.repository.attach(manager, image);
  }

  async readable(id: string, actor: Actor): Promise<FileReadDescriptor> {
    const file = await this.repository.findReadable(id, actor);

    if (!file) {
      throw new ProblemException(404, 'FILE_NOT_FOUND', 'File not found');
    }

    return {
      id: file.id,
      objectKey: file.objectKey,
      ownerEmployeeId: file.ownerEmployeeId,
      purpose: file.purpose,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    };
  }

  async outcome(
    actor: Actor,
    input: CommandOutcomeInput,
  ): Promise<CommandOutcome> {
    const receipt = await this.repository.findCommitted(actor.id, input);

    if (!receipt || !receipt.result || !receipt.httpStatus) {
      return { state: 'UNKNOWN' };
    }

    return {
      state: 'COMMITTED',
      status: receipt.httpStatus,
      body: publicReceipt(receipt.result),
      resourceId: receipt.resourceId,
    };
  }
}
