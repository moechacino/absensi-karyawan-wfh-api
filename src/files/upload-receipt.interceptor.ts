import { Clock } from '../runtime/clock';
import { Injectable } from '@nestjs/common';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { Observable } from 'rxjs';

export type UploadRequest = AuthenticatedRequest & {
  fullUploadReceivedAt: Date;
};

// Register after Multer and before controller pipes on the check-in route.
@Injectable()
export class UploadReceiptInterceptor implements NestInterceptor {
  constructor(private readonly clock: Clock) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    context.switchToHttp().getRequest<UploadRequest>().fullUploadReceivedAt =
      this.clock.now();

    return next.handle();
  }
}
