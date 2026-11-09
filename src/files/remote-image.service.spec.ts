import { SystemClock } from '../runtime/clock';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ProblemException } from '../http/problem';
import { RemoteImageService } from './remote-image.service';
import type { AttendanceClient } from '../gateway-attendance/attendance-client.service';
import type { ImageService } from './image.service';
import type { StorageService } from './storage.service';
import { checkInCommand } from '../attendance-rpc/check-in.command';
import { fingerprint } from '../idempotency/fingerprint';

const input = {
  bytes: Buffer.from('image'),
  mimeType: 'image/png',
  fileName: 'photo.png',
};
const context = { requestId: randomUUID(), accessToken: 'token' };
const receivedAt = new Date('2026-01-01T00:00:00.000Z');
const owner = randomUUID();
const missing = () =>
  new ProblemException(404, 'FILE_NOT_FOUND', 'File not found');

function setup() {
  const attendance = { call: jest.fn() };
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
  const service = new RemoteImageService(
    attendance as unknown as AttendanceClient,
    images as unknown as ImageService,
    storage as unknown as StorageService,
    new SystemClock(),
  );

  return {
    attendance,
    storage,
    images,
    service,
    run: () => service.checkIn(input, owner, receivedAt, randomUUID(), context),
  };
}

describe('RemoteImageService', () => {
  it.each([undefined, 'not-a-uuid'])(
    'rejects invalid key %s before decoding or staging bytes',
    async (key) => {
      const { service, storage, images } = setup();
      await expect(
        service.checkIn(input, owner, receivedAt, key as string, context),
      ).rejects.toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
      expect(images.validate).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    },
  );

  it('persists bytes before sending a descriptor, never a buffer, and preserves referenced success', async () => {
    const { run, attendance, storage } = setup();
    attendance.call.mockImplementation(
      async (pattern: string, request: unknown) => {
        expect(storage.put).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(request)).not.toContain('bytes');

        return pattern.endsWith('check-in')
          ? { status: 201, body: { id: 'record' }, replayed: false }
          : {};
      },
    );
    await run();
    const request = attendance.call.mock.calls[0][1];
    expect(request.fullUploadReceivedAt).toBe(receivedAt.toISOString());
    expect(request.stagedImage).toMatchObject({
      ownerEmployeeId: owner,
      purpose: 'CHECK_IN_PHOTO',
      sha256: 'a'.repeat(64),
    });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('reference-checks and removes a fresh unused replay candidate', async () => {
    const { run, attendance, storage } = setup();
    attendance.call
      .mockResolvedValueOnce({ status: 201, body: {}, replayed: true })
      .mockRejectedValueOnce(missing());
    await run();
    expect(storage.delete).toHaveBeenCalledWith(storage.put.mock.calls[0][0]);
  });

  it('cleans known rejection after a successful remote reference check', async () => {
    const { run, attendance, storage } = setup();
    const error = new ProblemException(422, 'INVALID_FILE', 'Invalid file');
    attendance.call
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(missing());
    await expect(run()).rejects.toBe(error);
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it.each([
    new ProblemException(503, 'ATTENDANCE_OUTCOME_UNKNOWN', 'Unknown'),
    new ProblemException(409, 'OPERATION_IN_PROGRESS', 'Busy'),
    new ProblemException(503, 'SERVICE_UNAVAILABLE', 'Unavailable'),
    new Error('Socket disconnected'),
  ])(
    'retains possibly committing bytes for %s without inferring absence',
    async (error) => {
      const { run, attendance, storage } = setup();
      attendance.call.mockRejectedValue(error);
      await expect(run()).rejects.toBe(error);
      expect(attendance.call).toHaveBeenCalledTimes(1);
      expect(storage.delete).not.toHaveBeenCalled();
    },
  );

  it('retains a replay candidate when its reference check fails', async () => {
    const { run, attendance, storage } = setup();
    attendance.call
      .mockResolvedValueOnce({ status: 201, body: {}, replayed: true })
      .mockRejectedValueOnce(new Error('Unavailable'));
    await run();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('does not turn successful commit into failure if direct cleanup fails', async () => {
    const { run, attendance, storage } = setup();
    attendance.call
      .mockResolvedValueOnce({ status: 201, body: {}, replayed: true })
      .mockRejectedValueOnce(missing());
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    storage.delete.mockRejectedValue(new Error('Disk unavailable'));
    try {
      await expect(run()).resolves.toMatchObject({ status: 201 });
    } finally {
      warning.mockRestore();
    }
  });

  it('uses only logical input and digest for fingerprints across keys, timestamps and staged IDs', () => {
    const image = { sha256: 'a'.repeat(64) };
    const first = checkInCommand(
      owner,
      randomUUID(),
      image,
      receivedAt.toISOString(),
    );
    const retry = checkInCommand(
      owner,
      randomUUID(),
      image,
      new Date().toISOString(),
    );
    expect(fingerprint(first.input, first.files)).toBe(
      fingerprint(retry.input, retry.files),
    );
    expect(fingerprint(first.input, first.files)).not.toBe(
      fingerprint({}, [{ field: 'photo', sha256: 'b'.repeat(64) }]),
    );
  });
});
