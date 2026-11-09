import {
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { StagedImage } from '../files/file.types';
import type { JsonObject } from '../idempotency/fingerprint';

export const attendanceOperations = [
  'checkIn',
  'checkOut',
  'changeWorkSchedule',
  'changeHolidayCalendar',
] as const;

export class FileAccessInput {
  @IsUUID()
  fileId: string;
}

export class CommandOutcomeInput {
  @IsIn(attendanceOperations)
  operation: (typeof attendanceOperations)[number];

  @IsUUID()
  key: string;

  @Matches(/^[a-f0-9]{64}$/)
  fingerprint: string;
}

// Internal only. Opaque keys are never returned by public HTTP endpoints.
export class StagedCheckInImage implements StagedImage {
  @IsUUID('4')
  id: string;

  @IsString()
  @MaxLength(41)
  objectKey: string;

  @IsUUID()
  ownerEmployeeId: string;

  @IsIn(['CHECK_IN_PHOTO'])
  purpose: 'CHECK_IN_PHOTO';

  @IsString()
  @MaxLength(255)
  fileName: string;

  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  mimeType: StagedImage['mimeType'];

  @IsInt()
  @Min(1)
  @Max(5 * 1024 * 1024)
  sizeBytes: number;

  @Matches(/^[a-f0-9]{64}$/)
  sha256: string;

  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  stagedAt: string;
}

export type FileReadDescriptor = StagedImage;

export type CommandOutcome =
  | { state: 'UNKNOWN' }
  | {
      state: 'COMMITTED';
      status: number;
      body: JsonObject;
      resourceId: string | null;
    };
