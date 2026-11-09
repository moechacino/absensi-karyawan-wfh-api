import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuthRepository } from '../auth/auth.repository';
import { FileModule } from '../files/file.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { OrganizationGuard } from '../organization/organization.guard';
import { MultipartOnlyGuard } from '../http/parsing';
import { EmployeeController } from './employee.controller';
import { EmployeeService } from './employee.service';
import { EmployeeRepository } from './employee.repository';
@Module({
  imports: [AuthModule, FileModule, IdempotencyModule],
  controllers: [EmployeeController],
  providers: [
    EmployeeService,
    EmployeeRepository,
    AuthRepository,
    OrganizationGuard,
    MultipartOnlyGuard,
  ],
})
export class EmployeeModule {}
