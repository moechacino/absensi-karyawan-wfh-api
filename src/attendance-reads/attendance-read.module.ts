import { Module } from '@nestjs/common';
import { WorkCalendarModule } from '../work-calendar/calendar.module';
import { AttendanceReadRepository } from './attendance-read.repository';
import { MonitoringRepository } from './monitoring.repository';
import { AttendanceReadService } from './attendance-read.service';
import { AttendanceReadRpcController } from './attendance-read.rpc-controller';

@Module({
  imports: [WorkCalendarModule],
  controllers: [AttendanceReadRpcController],
  providers: [
    AttendanceReadRepository,
    MonitoringRepository,
    AttendanceReadService,
  ],
})
export class AttendanceReadModule {}
