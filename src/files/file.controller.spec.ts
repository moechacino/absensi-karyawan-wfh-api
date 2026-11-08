import { PassThrough, Readable } from 'node:stream';
import type { Response } from 'express';
import { FileController } from './file.controller';
import type { FileService } from './file.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';

describe('FileController streaming', () => {
  function setup(stream: Readable, method = 'GET') {
    const response = Object.assign(new PassThrough(), { setHeader: jest.fn() });
    const files = {
      content: jest.fn().mockResolvedValue({
        stream,
        mimeType: 'image/png',
        sizeBytes: 3,
        fileName: 'photo.png',
      }),
    };
    const controller = new FileController(files as unknown as FileService);
    const request = {
      method,
      actor: { id: 'owner', role: 'EMPLOYEE' },
    } as AuthenticatedRequest;

    return {
      response,
      run: () =>
        controller.content('file-id', request, response as unknown as Response),
    };
  }

  it('closes the content stream for HEAD without sending bytes', async () => {
    const stream = new PassThrough();
    const { run, response } = setup(stream, 'HEAD');
    await run();
    expect(stream.destroyed).toBe(true);
    expect(response.readableLength).toBe(0);
    expect(response.writableEnded).toBe(true);
  });

  it('destroys a partial response on midstream failure instead of appending JSON', async () => {
    const stream = Readable.from(
      (async function* () {
        yield Buffer.from('png');
        throw new Error('Disk read failed');
      })(),
    );
    const { run, response } = setup(stream);
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    await run();
    expect(response.destroyed).toBe(true);
    expect(Buffer.concat(chunks).toString()).toBe('png');
  });

  it('closes the source stream when the client disconnects', async () => {
    const stream = new PassThrough();
    const { run, response } = setup(stream);
    const done = run();
    setImmediate(() => response.destroy());
    await done;
    expect(stream.destroyed).toBe(true);
  });
});
