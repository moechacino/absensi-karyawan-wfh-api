import sharp from 'sharp';
import { ImageService } from './image.service';
import { fileConfig } from '../../test/file-fixture';

describe('ImageService', () => {
  const images = new ImageService(fileConfig());

  it.each(['jpeg', 'png', 'webp'] as const)(
    'fully decodes real %s bytes and sanitizes display names',
    async (format) => {
      const bytes = await sharp({
        create: { width: 2, height: 2, channels: 3, background: 'red' },
      })
        .toFormat(format)
        .toBuffer();
      const result = await images.validate({
        bytes,
        mimeType: `image/${format}`,
        fileName: '..\\private/hello\r\nworld',
      });
      expect(result.bytes).toEqual(bytes);
      expect(result.fileName).toBe('helloworld');
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it('rejects empty, oversized, MIME-spoofed and malformed content', async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();

    for (const input of [
      { bytes: Buffer.alloc(0), mimeType: 'image/png' },
      { bytes: Buffer.alloc(5242881), mimeType: 'image/png' },
      { bytes: png, mimeType: 'image/jpeg' },
      { bytes: png.subarray(0, png.length - 20), mimeType: 'image/png' },
      { bytes: Buffer.from('<svg/>'), mimeType: 'image/png' },
    ]) {
      await expect(
        images.validate({ ...input, fileName: 'test.png' }),
      ).rejects.toThrow();
    }
  });

  it('rejects compressed images beyond the decoded pixel limit', async () => {
    const bytes = await sharp({
      create: { width: 4001, height: 4001, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    await expect(
      images.validate({ bytes, mimeType: 'image/png', fileName: 'large.png' }),
    ).rejects.toMatchObject({ code: 'INVALID_FILE' });
  });
});
