import { Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { FileService } from './file.service';
import type { FileRepository } from './file.repository';
import type { StorageService } from './storage.service';
import type { ImageService } from './image.service';

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

  it('runs a no-file command without validation, storage or cleanup', async () => {
    const { service, images, storage, repository } = setup();
    const command = jest.fn().mockResolvedValue('committed');
    await expect(service.withAtomicFiles([], command)).resolves.toBe(
      'committed',
    );
    expect(command).toHaveBeenCalledWith([]);
    expect(images.validate).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(repository.retireIfUnreferenced).not.toHaveBeenCalled();
  });

  it('cleans earlier staged files if a later write fails without executing the command', async () => {
    const { service, storage, repository } = setup();
    const upload = {
      input,
      ownerEmployeeId: owner,
      purpose: 'EMPLOYEE_PROFILE_PHOTO' as const,
    };
    storage.put
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Second write failed'));
    const command = jest.fn();
    await expect(
      service.withAtomicFiles([upload, upload], command),
    ).rejects.toThrow('Second write failed');
    expect(command).not.toHaveBeenCalled();
    expect(repository.retireIfUnreferenced).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(storage.put.mock.calls[0][0]);
  });

  it('stages all files before SQL and waits for the complete command before reference-safe cleanup', async () => {
    const { service, storage, repository } = setup(true);
    const upload = {
      input,
      ownerEmployeeId: owner,
      purpose: 'EMPLOYEE_PROFILE_PHOTO' as const,
    };
    const manager = {} as EntityManager;
    let entered!: () => void;
    let commit!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const committed = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const result = service.withAtomicFiles([upload, upload], async (files) => {
      expect(storage.put).toHaveBeenCalledTimes(2);

      for (const file of files) {
        await service.attach(manager, file);
      }

      entered();
      await committed;

      return 'committed';
    });

    try {
      await started;
      expect(repository.attach).toHaveBeenCalledTimes(2);
      expect(repository.retireIfUnreferenced).not.toHaveBeenCalled();
    } finally {
      commit();
    }

    await expect(result).resolves.toBe('committed');
    expect(repository.retireIfUnreferenced).toHaveBeenCalledTimes(2);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('stages independent files concurrently and drains pending writes before cleaning up a failure', async () => {
    const { service, storage, repository } = setup();
    const upload = {
      input,
      ownerEmployeeId: owner,
      purpose: 'EMPLOYEE_PROFILE_PHOTO' as const,
    };
    let started!: () => void;
    let rejectFirst!: (error: Error) => void;
    let finishSecond!: () => void;
    let writes = 0;
    const bothStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const second = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    storage.put.mockImplementation(() => {
      writes++;

      if (writes === 2) started();

      return writes === 1 ? first : second;
    });
    const command = jest.fn();
    const failure = new Error('First write failed');
    const result = service.withAtomicFiles([upload, upload], command);
    const rejected = expect(result).rejects.toBe(failure);

    try {
      await bothStarted;
      rejectFirst(failure);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(command).not.toHaveBeenCalled();
      expect(repository.retireIfUnreferenced).not.toHaveBeenCalled();
    } finally {
      finishSecond();
    }

    await rejected;
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(storage.put.mock.calls[1][0]);
  });

  it('cleans independent files concurrently after the complete command settles', async () => {
    const { service, repository, storage } = setup();
    const upload = {
      input,
      ownerEmployeeId: owner,
      purpose: 'EMPLOYEE_PROFILE_PHOTO' as const,
    };
    let entered!: () => void;
    let finish!: () => void;
    let cleanups = 0;
    const bothCleaning = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      finish = resolve;
    });
    repository.retireIfUnreferenced.mockImplementation(async () => {
      cleanups++;

      if (cleanups === 2) entered();

      await released;

      return { referenced: false };
    });
    let committed = false;
    const result = service.withAtomicFiles([upload, upload], async () => {
      committed = true;

      return 'committed';
    });

    try {
      await bothCleaning;
      expect(committed).toBe(true);
      expect(storage.delete).not.toHaveBeenCalled();
    } finally {
      finish();
    }

    await expect(result).resolves.toBe('committed');
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });

  it('never removes historical evidence that is still referenced', async () => {
    const { service, storage } = setup(true);
    await service.deleteReplaced(owner);
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
