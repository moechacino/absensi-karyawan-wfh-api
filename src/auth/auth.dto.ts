import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, ValidateBy } from 'class-validator';

function PasswordLength(min: number, max: number): PropertyDecorator {
  return ValidateBy({
    name: 'passwordLength',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' &&
        Array.from(value).length >= min &&
        Array.from(value).length <= max,
    },
  });
}

export class LoginInput {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @PasswordLength(1, 128)
  password: string;
}

export class PasswordInput {
  @IsString()
  @PasswordLength(1, 128)
  currentPassword: string;

  @IsString()
  newPassword: string;

  @IsString()
  confirmPassword: string;
}
