import { Inject, Injectable } from '@nestjs/common';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { defer, finalize } from 'rxjs';
import type { Observable } from 'rxjs';
import { RUNTIME_CONFIG } from '../runtime/runtime.config';
import type { RuntimeConfig } from '../runtime/runtime.config';
import { ProblemException } from '../http/problem';

@Injectable()
export class FileUploadInterceptor implements NestInterceptor {
  private active = 0;

  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {}

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    if (this.active >= this.config.storage.maxConcurrentUploads) {
      throw new ProblemException(429, 'UPLOAD_LIMIT', 'Too many uploads', {
        retryAfter: 1,
      });
    }

    this.active++;

    return defer(() => next.handle()).pipe(
      finalize(() => {
        this.active--;
      }),
    );
  }
}
