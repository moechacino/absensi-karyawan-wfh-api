import { randomUUID } from 'node:crypto';
import {
  Catch,
  HttpException,
  ForbiddenException,
  PayloadTooLargeException,
  Logger,
} from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';

export interface FieldError {
  field: string;
  code: string;
  message: string;
}
interface ProblemOptions {
  detail?: string;
  errors?: FieldError[];
  details?: Record<string, unknown>;
  retryAfter?: number;
}

// Pass only deliberately public messages/details, never caught driver errors or request values.
export class ProblemException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    readonly title: string,
    readonly publicOptions: ProblemOptions = {},
  ) {
    super(title, status);
  }
}

export function responseHeaders(request: Request, response: Response): string {
  const existing = response.getHeader('X-Request-Id');
  const supplied = request.headers['x-request-id'];
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const id =
    typeof existing === 'string' && uuid.test(existing)
      ? existing
      : typeof supplied === 'string' && uuid.test(supplied)
        ? supplied
        : randomUUID();
  response.setHeader('X-Request-Id', id);
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  return id;
}

const defaults: Record<number, [string, string]> = {
  400: ['INVALID_REQUEST', 'Invalid request'],
  401: ['AUTHENTICATION_REQUIRED', 'Authentication required'],
  403: ['FORBIDDEN', 'Forbidden'],
  404: ['NOT_FOUND', 'Not found'],
  409: ['CONFLICT', 'Conflict'],
  413: ['PAYLOAD_TOO_LARGE', 'Payload too large'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type'],
  422: ['VALIDATION_FAILED', 'Validation failed'],
  429: ['RATE_LIMITED', 'Too many requests'],
  503: ['SERVICE_UNAVAILABLE', 'Service unavailable'],
};
const csrfMessages = new Set([
  'Cross-origin request detected from Sec-Fetch-Site header',
  'Cross-origin request detected, and/or browser is out of date: Sec-Fetch-Site is missing, and Origin does not match Host',
]);

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);
  catch(error: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const requestId = responseHeaders(request, response);
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const isCsrf =
      error instanceof ForbiddenException && csrfMessages.has(error.message);
    const [code, title] =
      error instanceof ProblemException
        ? [error.code, error.title]
        : isCsrf
          ? ['CSRF_ORIGIN_REJECTED', 'Cross-origin request rejected']
          : error instanceof PayloadTooLargeException &&
              error.message === 'File too large'
            ? ['FILE_TOO_LARGE', 'File too large']
            : (defaults[status] ?? ['INTERNAL_ERROR', 'Internal server error']);
    if (status >= 500) this.logger.error({ code, requestId });
    if (status === 401) {
      const invalidToken =
        error instanceof ProblemException &&
        ['TOKEN_INVALID', 'TOKEN_EXPIRED'].includes(error.code);
      response.setHeader(
        'WWW-Authenticate',
        invalidToken ? 'Bearer error="invalid_token"' : 'Bearer',
      );
    }

    const options =
      error instanceof ProblemException ? error.publicOptions : {};
    if (
      [409, 429, 503].includes(status) &&
      Number.isSafeInteger(options.retryAfter) &&
      options.retryAfter! > 0
    )
      response.setHeader('Retry-After', String(options.retryAfter));
    response
      .status(status)
      .type('application/problem+json')
      .send({
        type: `urn:absensi:error:${code.toLowerCase().replaceAll('_', '-')}`,
        title,
        status,
        code,
        requestId,
        ...(options.detail === undefined ? {} : { detail: options.detail }),
        ...(options.errors === undefined ? {} : { errors: options.errors }),
        ...(options.details === undefined ? {} : { details: options.details }),
      });
  }
}
