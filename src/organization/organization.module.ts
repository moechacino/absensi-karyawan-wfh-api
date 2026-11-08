import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';
import { OrganizationRepository } from './organization.repository';
import { OrganizationGuard } from './organization.guard';

@Module({
  imports: [AuthModule, IdempotencyModule],
  controllers: [OrganizationController],
  providers: [OrganizationService, OrganizationRepository, OrganizationGuard],
})
export class OrganizationModule {}
