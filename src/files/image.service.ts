import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { RUNTIME_CONFIG } from '../runtime/runtime.config';
import type { RuntimeConfig } from '../runtime/runtime.config';
import { ProblemException } from '../http/problem';
import type { ImageInput, ValidatedImage } from './file.types';

@Injectable()
export class ImageService {
  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {}

  async validate(input: ImageInput): Promise<ValidatedImage> {
    if (!Buffer.isBuffer(input.bytes) || !input.bytes.length) {
      throw new ProblemException(
        422,
        'INVALID_FILE',
        'A nonempty image is required',
      );
    }

    if (input.bytes.length > this.config.storage.maxFileBytes) {
      throw new ProblemException(
        413,
        'FILE_TOO_LARGE',
        'Image exceeds the size limit',
      );
    }

    // Snapshot mutable upload bytes before asynchronous decoding.
    const bytes = Buffer.from(input.bytes);

    try {
      const image = sharp(bytes, {
        failOn: 'warning',
        limitInputPixels: 16000000,
        animated: true,
      });
      const metadata = await image.metadata();
      const formats = {
        jpeg: ['image/jpeg', 'jpg'],
        png: ['image/png', 'png'],
        webp: ['image/webp', 'webp'],
      } as const;
      const format = formats[metadata.format as keyof typeof formats];

      if (
        !format ||
        (metadata.pages ?? 1) !== 1 ||
        !metadata.width ||
        !metadata.height ||
        input.mimeType !== format[0]
      ) {
        throw new Error('Unsupported image');
      }

      // Metadata alone does not detect truncated/corrupt compressed pixel data.
      await image.raw().toBuffer();
      const fileName = Buffer.from(input.fileName, 'utf8')
        .toString('utf8')
        .replace(/\\/g, '/')
        .split('/')
        .pop()!
        // Strip control and direction-changing characters from the display name.
        // oxlint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
        .trim();

      return {
        bytes,
        mimeType: format[0],
        extension: format[1],
        fileName:
          Array.from(fileName).slice(0, 200).join('') || `image.${format[1]}`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    } catch {
      throw new ProblemException(
        422,
        'INVALID_FILE',
        'Use a valid, single-frame JPEG, PNG or WebP image',
      );
    }
  }
}
