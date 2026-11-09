import { Module } from '@nestjs/common';

import { AttendanceRpcModule } from './attendance-rpc/rpc.module';
import { DatabaseModule } from './database/database.module';
import { WorkCalendarModule } from './work-calendar/calendar.module';

// Feature tasks add attendance/calendar providers here, never gateway AppModule.
@Module({ imports: [AttendanceRpcModule, DatabaseModule, WorkCalendarModule] })
export class AttendanceAppModule {}
