import { ClassSerializerInterceptor, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import type { RuntimeConfig } from '../runtime/runtime.config';
import { ProblemException, ProblemFilter, responseHeaders } from './problem';
import { httpValidationPipe } from './validation';

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
  app.useGlobalPipes(httpValidationPipe());
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
      'Idempotency-Replayed',
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
