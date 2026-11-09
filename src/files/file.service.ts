import { AttendanceClient } from '../gateway-attendance/attendance-client.service';
import type { GatewayRpcContext } from '../gateway-attendance/rpc.context';
import { stageImage } from './stage-image';
import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { ReadStream } from 'node:fs';
import { ProblemException } from '../http/problem';
import type { Actor } from '../auth/access-token.service';
import { FileRepository } from './file.repository';
import { StorageService } from './storage.service';
import { ImageService } from './image.service';
import type {
  ImageInput,
  ImagePurpose,
  StagedImage,
  FileUpload,
} from './file.types';

export interface FileContent {
  stream: ReadStream;
  mimeType: string;
  sizeBytes: number;
  fileName: string;
}

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);

  constructor(
    private readonly repository: FileRepository,
    private readonly storage: StorageService,
    private readonly images: ImageService,
    private readonly attendance: AttendanceClient,
  ) {}

  // The callback must resolve only after its owning SQL/idempotency command commits or replays.
  // Use FileUploadInterceptor before multipart parsing on public upload routes.

  async withAtomicFiles<T>(
    uploads: readonly FileUpload[],
    command: (files: readonly StagedImage[]) => Promise<T>,
  ): Promise<T> {
    // Drain every independent stage before cleanup, including when one upload fails.
    const results = await Promise.allSettled(
      uploads.map((upload) => this.stage(upload)),
    );
    const staged = results
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);

    try {
      const failure = results.find((result) => result.status === 'rejected');

      if (failure) {
        throw failure.reason;
      }

      return await command(staged);
    } finally {
      await Promise.all(staged.map((file) => this.cleanup(file)));
    }
  }

  // Existing single-image callers share the same staging/cleanup implementation.

  withStagedImage<T>(
    input: ImageInput,
    ownerEmployeeId: string,
    purpose: ImagePurpose,
    command: (file: StagedImage) => Promise<T>,
  ): Promise<T> {
    return this.withAtomicFiles(
      [{ input, ownerEmployeeId, purpose }],
      ([file]) => command(file),
    );
  }

  private async stage(upload: FileUpload): Promise<StagedImage> {
    if (upload.purpose !== 'EMPLOYEE_PROFILE_PHOTO') {
      throw new Error('Use the remote image lifecycle for check-in photos.');
    }

    return stageImage(upload, this.images, this.storage);
  }

  attach(manager: EntityManager, staged: StagedImage): Promise<void> {
    if (staged.purpose !== 'EMPLOYEE_PROFILE_PHOTO') {
      throw new Error('Attendance owns check-in image metadata.');
    }

    return this.repository.attach(manager, staged);
  }

  private async cleanup(staged: StagedImage): Promise<void> {
    try {
      const result = await this.repository.retireIfUnreferenced(staged.id);

      if (!result.referenced) {
        await this.storage.delete(result.objectKey ?? staged.objectKey);
      }
    } catch {
      // A failed cleanup must not turn a committed mutation into an apparent failure. Retain bytes if SQL state is unknown.
      this.logger.warn(
        'Unused image cleanup failed; manual recovery may be required.',
      );
    }
  }

  // Call after the owning replacement transaction commits.

  async deleteReplaced(id: string): Promise<void> {
    try {
      const result = await this.repository.retireIfUnreferenced(id);

      if (!result.referenced && result.objectKey) {
        await this.storage.delete(result.objectKey);
      }
    } catch {
      this.logger.warn(
        'Replaced image cleanup failed; manual recovery may be required.',
      );
    }
  }

  async content(
    id: string,
    actor: Actor,
    context: GatewayRpcContext,
  ): Promise<FileContent> {
    const metadata = await this.repository.findPurpose(id);

    if (!metadata) {
      throw new ProblemException(404, 'FILE_NOT_FOUND', 'File not found');
    }

    const file =
      metadata.purpose === 'CHECK_IN_PHOTO'
        ? await this.attendance.call('attendance.v1.file-access', {
            ...context,
            input: { fileId: id },
          })
        : await this.repository.findReadable(id, actor);

    if (!file) {
      throw new ProblemException(404, 'FILE_NOT_FOUND', 'File not found');
    }

    const handle = await this.storage.open(file.objectKey, file.sizeBytes);

    return {
      stream: handle.createReadStream({ autoClose: true }),
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      fileName: file.fileName,
    };
  }
}
