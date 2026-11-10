import { plainToInstance, Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  Length,
  MaxLength,
  validateSync,
} from 'class-validator';

export class ProvisionInput {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 160)
  fullName: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  initialPassword: string;

  @IsString()
  @Length(1, 40)
  divisionCode: string;

  @IsString()
  @Length(1, 160)
  divisionName: string;

  @IsString()
  @Length(1, 40)
  positionCode: string;

  @IsString()
  @Length(1, 160)
  positionName: string;
}

export function provisionInput(value: unknown): ProvisionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provide a provisioning JSON object on stdin.');
  }

  const input = plainToInstance(ProvisionInput, value);

  if (
    validateSync(input, { whitelist: true, forbidNonWhitelisted: true })
      .length ||
    Array.from(input.initialPassword).length < 8 ||
    Array.from(input.initialPassword).length > 128 ||
    [
      input.divisionCode,
      input.divisionName,
      input.positionCode,
      input.positionName,
    ].some((text) => !text.trim())
  ) {
    throw new Error(
      'Invalid provisioning fields; password requires 8–128 Unicode code points.',
    );
  }

  return input;
}

export type OperationsCommand =
  'provision-first-hrd' | 'seed-development' | 'cleanup-receipts';

export function operationsCommand(args: readonly string[]): {
  command: OperationsCommand;
  limit?: number;
} {
  if (
    args.length === 2 &&
    args[0] === 'provision-first-hrd' &&
    args[1] === '--confirm-empty-installation'
  ) {
    return { command: args[0] };
  }

  if (
    args.length === 2 &&
    args[0] === 'seed-development' &&
    args[1] === '--confirm-fictional-data'
  ) {
    return { command: args[0] };
  }

  if (
    args.length === 2 &&
    args[0] === 'cleanup-receipts' &&
    /^[1-9]\d{0,3}$/.test(args[1]) &&
    Number(args[1]) <= 1000
  ) {
    return { command: args[0], limit: Number(args[1]) };
  }

  throw new Error(
    'Use provision-first-hrd --confirm-empty-installation, seed-development --confirm-fictional-data, or cleanup-receipts <1–1000>.',
  );
}
