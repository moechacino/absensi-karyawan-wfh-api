import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { ReadStream } from 'node:fs';
import { RUNTIME_CONFIG } from '../runtime/runtime.config';
import type { RuntimeConfig } from '../runtime/runtime.config';
import { ProblemException } from '../http/problem';
import type { Actor } from '../auth/access-token.service';
import { FileRepository } from './file.repository';
import { StorageService } from './storage.service';
import { ImageService } from './image.service';
import type { ImageInput, ImagePurpose, StagedImage } from './file.types';

export interface FileContent {
  stream: ReadStream;
  mimeType: string;
  sizeBytes: number;
  fileName: string;
}

@Injectable()
export class FileService {
  private readonly logger = new Logger(FileService.name);
  private active = 0;

  constructor(
    private readonly repository: FileRepository,
    private readonly storage: StorageService,
    private readonly images: ImageService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  // Wrap the complete owning command (including commit/idempotency replay), not an inner transaction callback.

  async withStagedImage<T>(
    input: ImageInput,
    ownerEmployeeId: string,
    purpose: ImagePurpose,
    command: (file: StagedImage) => Promise<T>,
  ): Promise<T> {
    if (this.active >= this.config.storage.maxConcurrentUploads) {
      throw new ProblemException(429, 'UPLOAD_LIMIT', 'Too many uploads', {
        retryAfter: 1,
      });
    }

    if (!['CHECK_IN_PHOTO', 'EMPLOYEE_PROFILE_PHOTO'].includes(purpose)) {
      throw new ProblemException(
        422,
        'INVALID_FILE_PURPOSE',
        'Invalid image purpose',
      );
    }

    this.active++;
    let staged: StagedImage | undefined;
    let written = false;

    try {
      const image = await this.images.validate(input);
      const id = randomUUID();
      staged = {
        id,
        objectKey: `${id}.${image.extension}`,
        ownerEmployeeId,
        purpose,
        fileName: image.fileName,
        mimeType: image.mimeType,
        sizeBytes: image.bytes.length,
        sha256: image.sha256,
      };
      await this.storage.put(staged.objectKey, image.bytes);
      written = true;
      const result = await command(staged);
      await this.cleanup(staged);

      return result;
    } catch (error) {
      if (staged && written) {
        await this.cleanup(staged);
      }

      throw error;
    } finally {
      this.active--;
    }
  }

  attach(manager: EntityManager, staged: StagedImage): Promise<void> {
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

  async content(id: string, actor: Actor): Promise<FileContent> {
    const file = await this.repository.findReadable(id, actor);

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
