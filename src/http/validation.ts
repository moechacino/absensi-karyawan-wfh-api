import { ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { ProblemException } from './problem';
import type { FieldError } from './problem';

function fieldErrors(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const property = /^[A-Za-z_][A-Za-z0-9_]{0,63}$|^\d{1,6}$/.test(
      error.property,
    )
      ? error.property
      : 'field';
    const field = parent ? `${parent}.${property}` : property;
    return [
      ...(Object.keys(error.constraints ?? {}).length
        ? [
            {
              field,
              code: error.constraints?.whitelistValidation
                ? 'UNKNOWN_FIELD'
                : 'INVALID_VALUE',
              message: error.constraints?.whitelistValidation
                ? 'This field is not allowed.'
                : 'Use the documented field format.',
            },
          ]
        : []),
      ...fieldErrors(error.children ?? [], field),
    ];
  });
}

export function httpValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    exceptionFactory: (errors) =>
      new ProblemException(400, 'VALIDATION_FAILED', 'Validation failed', {
        errors: fieldErrors(errors),
      }),
  });
}
