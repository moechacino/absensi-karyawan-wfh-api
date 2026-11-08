import { Module } from '@nestjs/common';
import { IdempotencyRepository } from './idempotency.repository';
import { IdempotencyService } from './idempotency.service';

@Module({
  providers: [IdempotencyRepository, IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
