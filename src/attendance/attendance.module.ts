import { Module } from '@nestjs/common';
import { AttendanceFileModule } from '../attendance-files/attendance-file.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { ScheduleModule } from '../work-schedule/schedule.module';
import { AttendanceRepository } from './attendance.repository';
import { AttendanceService } from './attendance.service';
import { AttendanceOwnerGuard } from './attendance-owner.guard';
import { AttendanceRpcController } from './attendance.rpc-controller';

@Module({
  imports: [AttendanceFileModule, IdempotencyModule, ScheduleModule],
  controllers: [AttendanceRpcController],
  providers: [AttendanceRepository, AttendanceService, AttendanceOwnerGuard],
})
export class AttendanceModule {}
