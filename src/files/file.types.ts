import type { FileObjectEntity } from '../database/entities';

export type ImagePurpose = FileObjectEntity['purpose'];
export interface ImageInput {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}
export interface ValidatedImage {
  bytes: Buffer;
  mimeType: FileObjectEntity['mimeType'];
  extension: 'jpg' | 'png' | 'webp';
  fileName: string;
  sha256: string;
}
export interface StagedImage {
  id: string;
  objectKey: string;
  ownerEmployeeId: string;
  purpose: ImagePurpose;
  fileName: string;
  mimeType: FileObjectEntity['mimeType'];
  sizeBytes: number;
  sha256: string;
}

// Current policies accept images. New document policies can reuse the command lifecycle.
export interface FileUpload {
  input: ImageInput;
  ownerEmployeeId: string;
  purpose: ImagePurpose;
}
