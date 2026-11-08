import type { EntityManager } from 'typeorm';
import type { Json, JsonObject, FileDigest } from './fingerprint';

export const operations = [
  'createEmployee',
  'updateEmployee',
  'createDivision',
  'createPosition',
  'changeWorkSchedule',
  'changeHolidayCalendar',
  'checkIn',
  'checkOut',
] as const;

export type IdempotentOperation = (typeof operations)[number];

export const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface IdempotencyCommand {
  actorId: string;
  operation: IdempotentOperation;
  key: string;
  input: JsonObject;
  files?: readonly FileDigest[];
  resourceId?: string;
  receivedAt?: Date;
}

export interface StoredResult {
  status: number;
  body: JsonObject;
  resourceId?: string;
}

export interface IdempotencyHandlers {
  perform(
    manager: EntityManager,
    context: { receivedAt: Date },
  ): Promise<StoredResult>;
  present?(
    manager: EntityManager,
    result: StoredResult,
    replayed: boolean,
  ): Promise<Json>;
}

export interface IdempotentResult {
  status: number;
  body: Json;
  replayed: boolean;
}
