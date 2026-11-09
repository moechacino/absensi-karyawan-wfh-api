import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { RUNTIME_CONFIG } from '../runtime/runtime.config';
import type { RuntimeConfig } from '../runtime/runtime.config';
import { ProblemException } from '../http/problem';

@Injectable()
export class StorageService {
  private rootIdentity?: { path: string; dev: number; ino: number };

  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {}

  private async path(key: string): Promise<string> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/.test(
        key,
      )
    ) {
      throw new Error('Invalid internal storage key');
    }

    const root = this.config.storage.root;
    const stat = await lstat(root);

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Storage root must be a private directory');
    }

    const canonical = await realpath(root);

    if (
      this.rootIdentity &&
      (this.rootIdentity.path !== canonical ||
        this.rootIdentity.dev !== stat.dev ||
        this.rootIdentity.ino !== stat.ino)
    ) {
      throw new Error('Storage root changed');
    }

    this.rootIdentity ??= { path: canonical, dev: stat.dev, ino: stat.ino };

    return join(canonical, key);
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    let handle: FileHandle | undefined;
    let path: string | undefined;
    let created = false;

    try {
      path = await this.path(key);
      handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      const directory = await open(
        this.config.storage.root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );

      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      await handle?.close().catch(() => undefined);

      if (created && path) {
        await unlink(path).catch(() => undefined);
      }

      throw new ProblemException(
        503,
        'FILE_STORAGE_UNAVAILABLE',
        'File storage unavailable',
      );
    }
  }

  async open(key: string, expectedSize: number): Promise<FileHandle> {
    let handle: FileHandle | undefined;

    try {
      handle = await open(
        await this.path(key),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await handle.stat();

      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expectedSize) {
        throw new Error('Invalid stored content');
      }

      return handle;
    } catch {
      await handle?.close().catch(() => undefined);

      throw new ProblemException(
        503,
        'FILE_CONTENT_UNAVAILABLE',
        'File content unavailable',
      );
    }
  }

  async read(key: string, size: number): Promise<Buffer> {
    if (
      !Number.isInteger(size) ||
      size < 1 ||
      size > this.config.storage.maxFileBytes
    ) {
      throw new ProblemException(422, 'INVALID_FILE', 'Invalid staged image');
    }

    const handle = await this.open(key, size);

    try {
      const bytes = Buffer.alloc(size);
      let offset = 0;

      while (offset < size) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          size - offset,
          offset,
        );

        if (!bytesRead) {
          throw new ProblemException(
            503,
            'FILE_CONTENT_UNAVAILABLE',
            'File content unavailable',
          );
        }

        offset += bytesRead;
      }

      if ((await handle.stat()).size !== size) {
        throw new ProblemException(
          503,
          'FILE_CONTENT_UNAVAILABLE',
          'File content unavailable',
        );
      }

      return bytes;
    } finally {
      await handle.close();
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(await this.path(key));
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return;
      }

      throw new ProblemException(
        503,
        'FILE_STORAGE_UNAVAILABLE',
        'File storage unavailable',
      );
    }
  }
}
