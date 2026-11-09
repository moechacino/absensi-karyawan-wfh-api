import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { multipartBoolean, multipartVersion } from '../http/parsing';
import { PositionQuery } from '../organization/organization.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const email = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const optional = (_object: unknown, value: unknown) => value !== undefined;

export class EmployeeQuery extends PositionQuery {
  @ValidateIf(optional) @IsIn(['EMPLOYEE', 'HRD']) role?: 'EMPLOYEE' | 'HRD';
}
export class EmployeeCreate {
  @Transform(trim) @IsString() @Length(1, 160) fullName: string;
  @Transform(email) @IsEmail() @MaxLength(254) email: string;
  @IsUUID() divisionId: string;
  @IsUUID() positionId: string;
  @IsIn(['EMPLOYEE', 'HRD']) role: 'EMPLOYEE' | 'HRD';
  @IsIn(['ACTIVE', 'INACTIVE']) status: 'ACTIVE' | 'INACTIVE';
  @ValidateIf(optional)
  @Transform(({ value }) => multipartBoolean(value, 'confirmHrAccess'))
  @IsBoolean()
  confirmHrAccess?: boolean;
}
export class EmployeePatch {
  @Transform(({ value }) => multipartVersion(value))
  @IsInt()
  @Min(0)
  expectedVersion: number;
  @ValidateIf(optional)
  @Transform(trim)
  @IsString()
  @Length(1, 160)
  fullName?: string;
  @ValidateIf(optional)
  @Transform(email)
  @IsEmail()
  @MaxLength(254)
  email?: string;
  @ValidateIf(optional) @IsUUID() divisionId?: string;
  @ValidateIf(optional) @IsUUID() positionId?: string;
  @ValidateIf(optional) @IsIn(['ACTIVE', 'INACTIVE']) status?:
    'ACTIVE' | 'INACTIVE';
  @ValidateIf(optional)
  @Transform(({ value }) => multipartBoolean(value))
  @IsBoolean()
  removePhoto?: boolean;
}
export class RoleChange {
  @IsIn(['EMPLOYEE', 'HRD']) role: 'EMPLOYEE' | 'HRD';
  @IsBoolean() confirmHrAccess: boolean;
  @IsInt() @Min(0) expectedVersion: number;
}
