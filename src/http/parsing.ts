import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { ProblemException } from './problem';

function invalid(field: string): never {
  throw new ProblemException(400, 'INVALID_REQUEST', 'Invalid request', {
    errors: [
      {
        field,
        code: 'INVALID_VALUE',
        message: 'Use the documented field format.',
      },
    ],
  });
}

export function multipartVersion(
  value: unknown,
  field = 'expectedVersion',
): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value))
    return invalid(field);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) return invalid(field);
  return result;
}

export function multipartBoolean(
  value: unknown,
  field = 'removePhoto',
): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return invalid(field);
}

function queryInteger(value: unknown, field: string): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
    return invalid(field);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) return invalid(field);
  return result;
}

export class PaginationQuery {
  @Transform(({ value }) => queryInteger(value, 'page'))
  @IsInt()
  @Min(1)
  page = 1;

  @Transform(({ value }) => queryInteger(value, 'pageSize'))
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}

// Map a declared public choice to a fixed server-owned order, never interpolate input into SQL.
export function allowedOrder<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T))
    return invalid('sort');
  return value as T;
}

// A FileInterceptor alone skips non-multipart requests; parent upload commands must also enforce their transport.
@Injectable()
export class MultipartOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!context.switchToHttp().getRequest<Request>().is('multipart/form-data'))
      throw new ProblemException(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Multipart form required',
      );
    return true;
  }
}
