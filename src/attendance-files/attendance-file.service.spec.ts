import { randomUUID } from 'node:crypto';
import { AttendanceFileService } from './attendance-file.service';
import type { AttendanceFileRepository } from './attendance-file.repository';
import type { ImageService } from '../files/image.service';
import type { StorageService } from '../files/storage.service';
import type { StagedCheckInImage } from '../attendance-rpc/rpc.files';

const actor = { id: randomUUID(), role: 'EMPLOYEE' as const };
const id = randomUUID();
const staged = {
  id,
  objectKey: `${id}.png`,
  ownerEmployeeId: actor.id,
  purpose: 'CHECK_IN_PHOTO',
  fileName: 'photo.png',
  mimeType: 'image/png',
  sizeBytes: 123,
  sha256: 'a'.repeat(64),
  stagedAt: '2026-01-01T00:00:00.001Z',
} satisfies StagedCheckInImage;
const receipt = '2026-01-01T00:00:00.000Z';

function setup() {
  const repository = {
    attach: jest.fn(),
    findReadable: jest.fn(),
    findCommitted: jest.fn(),
  };
  const storage = { read: jest.fn().mockResolvedValue(Buffer.from('bytes')) };
  const images = {
    validate: jest
      .fn()
      .mockResolvedValue({ sha256: staged.sha256, fileName: staged.fileName }),
  };
  const service = new AttendanceFileService(
    repository as unknown as AttendanceFileRepository,
    storage as unknown as StorageService,
    images as unknown as ImageService,
  );

  return { service, repository, storage, images };
}

describe('AttendanceFileService', () => {
  it('verifies actual private bytes before SQL, using the issued actor', async () => {
    const { service, storage, images, repository } = setup();
    await service.verify(staged, actor, receipt);
    expect(storage.read).toHaveBeenCalledWith(
      staged.objectKey,
      staged.sizeBytes,
    );
    expect(images.validate).toHaveBeenCalledWith({
      bytes: Buffer.from('bytes'),
      mimeType: staged.mimeType,
      fileName: staged.fileName,
    });
    expect(repository.attach).not.toHaveBeenCalled();
  });

  it.each([
    { ownerEmployeeId: randomUUID() },
    { purpose: 'EMPLOYEE_PROFILE_PHOTO' },
    { objectKey: '../photo.png' },
    { objectKey: `${randomUUID()}.png` },
    { stagedAt: 'invalid' },
    { stagedAt: '2025-01-01T00:00:00.000Z' },
  ])('rejects a forged descriptor %j before reading bytes', async (change) => {
    const { service, storage } = setup();
    await expect(
      service.verify(
        { ...staged, ...change } as StagedCheckInImage,
        actor,
        receipt,
      ),
    ).rejects.toThrow();
    expect(storage.read).not.toHaveBeenCalled();
  });

  it.each([{ sha256: 'b'.repeat(64) }, { fileName: 'different.png' }])(
    'rejects attestation mismatch %j',
    async (change) => {
      const { service, images } = setup();
      images.validate.mockResolvedValue({
        sha256: staged.sha256,
        fileName: staged.fileName,
        ...change,
      });
      await expect(
        service.verify(staged, actor, receipt),
      ).rejects.toMatchObject({ code: 'INVALID_FILE' });
    },
  );

  it('hides missing, unbound and inaccessible files behind one 404', async () => {
    const { service, repository } = setup();
    repository.findReadable.mockResolvedValue(null);
    await expect(service.readable(id, actor)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
    expect(repository.findReadable).toHaveBeenCalledWith(id, actor);
  });

  it('only returns an explicitly selected internal descriptor', async () => {
    const { service, repository } = setup();
    repository.findReadable.mockResolvedValue({
      ...staged,
      state: 'ATTACHED',
      unexpected: 'private',
    });
    expect(await service.readable(id, actor)).toEqual(
      expect.not.objectContaining({ unexpected: 'private' }),
    );
  });

  it('treats a missing/in-flight receipt as UNKNOWN and has no cleanup side effects', async () => {
    const { service, repository, storage } = setup();
    repository.findCommitted.mockResolvedValue(null);
    await expect(
      service.outcome(actor, {
        operation: 'checkIn',
        key: randomUUID(),
        fingerprint: 'a'.repeat(64),
      }),
    ).resolves.toEqual({ state: 'UNKNOWN' });
    expect(storage.read).not.toHaveBeenCalled();
  });

  it('returns the safe committed receipt under actor/operation/key/hash scope', async () => {
    const { service, repository } = setup();
    const input = {
      operation: 'checkIn' as const,
      key: randomUUID(),
      fingerprint: 'a'.repeat(64),
    };
    repository.findCommitted.mockResolvedValue({
      result: { id },
      httpStatus: 201,
      resourceId: id,
    });
    await expect(service.outcome(actor, input)).resolves.toEqual({
      state: 'COMMITTED',
      status: 201,
      body: { id },
      resourceId: id,
    });
    expect(repository.findCommitted).toHaveBeenCalledWith(actor.id, input);
  });

  it('refuses to leak secret-bearing stored results', async () => {
    const { service, repository } = setup();
    repository.findCommitted.mockResolvedValue({
      result: { objectKey: staged.objectKey },
      httpStatus: 201,
    });
    await expect(
      service.outcome(actor, {
        operation: 'checkIn',
        key: randomUUID(),
        fingerprint: 'a'.repeat(64),
      }),
    ).rejects.toThrow('Secret-bearing');
  });
});
