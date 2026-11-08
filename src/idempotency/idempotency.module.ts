import { LocalCommandRunner } from './local-command-runner.service';
import { Module } from '@nestjs/common';
import { IdempotencyRepository } from './idempotency.repository';
import { IdempotencyService } from './idempotency.service';

@Module({
  providers: [IdempotencyRepository, IdempotencyService, LocalCommandRunner],
  exports: [IdempotencyService, LocalCommandRunner],
})
export class IdempotencyModule {}
