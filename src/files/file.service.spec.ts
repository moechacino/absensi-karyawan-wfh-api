import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { FileService } from './file.service';
import type { FileRepository } from './file.repository';
import type { StorageService } from './storage.service';
import type { ImageService } from './image.service';
import { fileConfig } from '../../test/file-fixture';

const input = {
  bytes: Buffer.from('validated bytes'),
  mimeType: 'image/png',
  fileName: 'photo.png',
};
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('FileService', () => {
  function setup(referenced = false) {
    const repository = {
      attach: jest.fn().mockResolvedValue(undefined),
      retireIfUnreferenced: jest.fn().mockResolvedValue({ referenced }),
    };
    const storage = {
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const images = {
      validate: jest.fn().mockResolvedValue({
        ...input,
        extension: 'png',
        sha256: 'a'.repeat(64),
      }),
    };
    const service = new FileService(
      repository as unknown as FileRepository,
      storage as unknown as StorageService,
      images as unknown as ImageService,
      fileConfig(),
    );

    return { service, repository, storage, images };
  }

  it('stages bytes before the parent command and preserves committed referenced images', async () => {
    const { service, repository, storage } = setup(true);
    const manager = {} as EntityManager;
    await expect(
      service.withStagedImage(
        input,
        owner,
        'EMPLOYEE_PROFILE_PHOTO',
        async (staged) => {
          expect(storage.put).toHaveBeenCalledWith(
            staged.objectKey,
            input.bytes,
          );
          await service.attach(manager, staged);

          return 'committed';
        },
      ),
    ).resolves.toBe('committed');
    expect(repository.attach).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ ownerEmployeeId: owner }),
    );
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('deletes unused staged bytes on idempotent replay', async () => {
    const { service, storage } = setup();
    await service.withStagedImage(
      input,
      owner,
      'CHECK_IN_PHOTO',
      async () => 'replayed',
    );
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it('cleans up after SQL rollback and preserves the original error', async () => {
    const { service, storage } = setup();
    const error = new Error('SQL failure');
    await expect(
      service.withStagedImage(input, owner, 'CHECK_IN_PHOTO', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it('does not run SQL or cleanup someone else’s bytes when the write fails', async () => {
    const { service, storage, repository } = setup();
    storage.put.mockRejectedValue(new Error('Disk failure'));
    const command = jest.fn();
    await expect(
      service.withStagedImage(input, owner, 'CHECK_IN_PHOTO', command),
    ).rejects.toThrow('Disk failure');
    expect(command).not.toHaveBeenCalled();
    expect(repository.retireIfUnreferenced).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('retains bytes if the outcome of SQL is unknown and logs a safe cleanup warning', async () => {
    const { service, repository, storage } = setup();
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    repository.retireIfUnreferenced.mockRejectedValue(
      new Error('Database unavailable'),
    );

    try {
      await expect(
        service.withStagedImage(
          input,
          owner,
          'CHECK_IN_PHOTO',
          async () => 'committed',
        ),
      ).resolves.toBe('committed');
      expect(storage.delete).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it('never removes historical evidence that is still referenced', async () => {
    const { service, storage } = setup(true);
    await service.deleteReplaced(owner);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
