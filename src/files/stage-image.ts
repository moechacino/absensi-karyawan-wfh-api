import { randomUUID } from 'node:crypto';
import type { ImageService } from './image.service';
import type { StorageService } from './storage.service';
import type { FileUpload, StagedImage } from './file.types';

export async function stageImage(
  upload: FileUpload,
  images: ImageService,
  storage: StorageService,
): Promise<StagedImage> {
  const image = await images.validate(upload.input);
  const id = randomUUID();
  const staged: StagedImage = {
    id,
    objectKey: `${id}.${image.extension}`,
    ownerEmployeeId: upload.ownerEmployeeId,
    purpose: upload.purpose,
    fileName: image.fileName,
    mimeType: image.mimeType,
    sizeBytes: image.bytes.length,
    sha256: image.sha256,
  };
  await storage.put(staged.objectKey, image.bytes);

  return staged;
}
