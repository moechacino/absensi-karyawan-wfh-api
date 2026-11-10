import { Module } from '@nestjs/common';

import { RuntimeModule } from '../runtime/runtime.module';
import { DatabaseModule } from '../database/database.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';

import { ProvisionRepository } from './provision.repository';
import { ProvisionService } from './provision.service';
import { DemoSeedRepository } from './demo-seed.repository';
import { DemoSeedService } from './demo-seed.service';

@Module({
  imports: [RuntimeModule, DatabaseModule, IdempotencyModule],
  providers: [
    ProvisionRepository,
    ProvisionService,
    DemoSeedRepository,
    DemoSeedService,
  ],
})
export class OperationsModule {}
