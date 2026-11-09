import { Module } from '@nestjs/common';

import { EmployeeModule } from './employees/employee.module';
import { OrganizationModule } from './organization/organization.module';
import { FileModule } from './files/file.module';
import { AuthModule } from './auth/auth.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { HttpModule } from './http/http.module';
import { DatabaseModule } from './database/database.module';
import { RuntimeModule } from './runtime/runtime.module';
import { ScheduleGatewayModule } from './work-schedule/schedule.gateway-module';
import { GatewayAttendanceModule } from './gateway-attendance/gateway-attendance.module';

@Module({
  imports: [
    RuntimeModule,
    GatewayAttendanceModule,
    ScheduleGatewayModule,
    DatabaseModule,
    HttpModule,
    IdempotencyModule,
    AuthModule,
    FileModule,
    OrganizationModule,
    EmployeeModule,
  ],
})
export class AppModule {}
