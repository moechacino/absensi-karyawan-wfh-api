import {
  ClassSerializerInterceptor,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import type { RuntimeConfig } from '../runtime/runtime.config';
import { ProblemException, ProblemFilter, responseHeaders } from './problem';
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

export function configureHttp(
  app: NestExpressApplication,
  config: RuntimeConfig,
): void {
  app.setGlobalPrefix('api/v1');
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // Do not trust forwarded Host/protocol from arbitrary clients. Deployment proxy trust is explicit future operations work.
  app.set('trust proxy', false);
  app.use((request: Request, response: Response, next: NextFunction) => {
    responseHeaders(request, response);
    next();
  });
  app.useGlobalFilters(new ProblemFilter());
  app.useGlobalPipes(
    new ValidationPipe({
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
    }),
  );
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
  app.enableCors({
    origin: [...config.browser.corsOrigins],
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Request-Id',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'WWW-Authenticate',
      'Retry-After',
      'Content-Disposition',
    ],
    optionsSuccessStatus: 204,
  });
  app.enableCsrfProtection({
    trustedOrigins: [...config.browser.csrfTrustedOrigins],
  });
  app.use((request: Request, _response: Response, next: NextFunction) => {
    const hasBody =
      request.headers['transfer-encoding'] !== undefined ||
      Number(request.headers['content-length'] ?? 0) > 0;
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      hasBody &&
      !request.is('application/json') &&
      !request.is('multipart/form-data')
    ) {
      next(
        new ProblemException(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'Unsupported media type',
        ),
      );
      return;
    }
    next();
  });
  // Nest's prefixed 404 router does not cover other paths. Forward them to its root error layer.
  app.use((request: Request, _response: Response, next: NextFunction) => {
    if (!request.path.startsWith('/api/v1/') || request.path === '/api/v1/') {
      next(new NotFoundException());
      return;
    }
    next();
  });
  app.useBodyParser('json', { limit: 1024 * 1024, strict: true });
}
