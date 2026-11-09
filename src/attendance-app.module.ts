import { AttendanceReadModule } from './attendance-reads/attendance-read.module';
import { AttendanceFileModule } from './attendance-files/attendance-file.module';
import { AttendanceModule } from './attendance/attendance.module';
import { Module } from '@nestjs/common';

import { AttendanceRpcModule } from './attendance-rpc/rpc.module';
import { DatabaseModule } from './database/database.module';
import { ScheduleModule } from './work-schedule/schedule.module';
import { WorkCalendarModule } from './work-calendar/calendar.module';
import { HolidayModule } from './holidays/holiday.module';

// Feature tasks add attendance/calendar providers here, never gateway AppModule.
@Module({
  imports: [
    AttendanceReadModule,
    AttendanceModule,
    AttendanceFileModule,
    HolidayModule,
    AttendanceRpcModule,
    DatabaseModule,
    WorkCalendarModule,
    ScheduleModule,
  ],
})
export class AttendanceAppModule {}
