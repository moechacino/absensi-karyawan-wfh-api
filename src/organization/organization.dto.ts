import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { PaginationQuery } from '../http/parsing';
import type { Status } from './organization.types';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class DivisionQuery extends PaginationQuery {
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  q?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: Status;
}

export class PositionQuery extends DivisionQuery {
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  divisionId?: string;
}

export class DivisionCreate {
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  code: string;

  @Transform(trim)
  @IsString()
  @Length(1, 160)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @IsIn(['ACTIVE', 'INACTIVE'])
  status: Status;
}

export class PositionCreate {
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  code: string;

  @Transform(trim)
  @IsString()
  @Length(1, 160)
  name: string;

  @IsUUID()
  divisionId: string;

  @IsIn(['ACTIVE', 'INACTIVE'])
  status: Status;
}

export class DivisionPatch {
  @IsInt()
  @Min(0)
  expectedVersion: number;

  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  code?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: Status;
}

export class PositionPatch {
  @IsInt()
  @Min(0)
  expectedVersion: number;

  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  code?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 160)
  name?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  divisionId?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: Status;
}
