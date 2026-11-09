import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { UploadReceiptInterceptor } from './upload-receipt.interceptor';
import type { UploadRequest } from './upload-receipt.interceptor';

describe('UploadReceiptInterceptor', () => {
  it('pins receipt immediately after multipart parsing, before downstream decoding/storage waits', () => {
    jest.useFakeTimers();
    const now = new Date('2026-01-01T00:00:00.000Z');
    jest.setSystemTime(now);
    const request = {} as UploadRequest;
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext;
    const next: CallHandler = {
      handle: () => {
        expect(request.fullUploadReceivedAt).toEqual(now);
        jest.advanceTimersByTime(60000);

        return of('done');
      },
    };

    try {
      new UploadReceiptInterceptor().intercept(context, next);
      expect(request.fullUploadReceivedAt).toEqual(now);
    } finally {
      jest.useRealTimers();
    }
  });
});
