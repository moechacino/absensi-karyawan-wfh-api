import { Module } from '@nestjs/common';

import { AttendanceRpcModule } from './attendance-rpc/rpc.module';
import { DatabaseModule } from './database/database.module';

// Feature tasks add attendance/calendar providers here, never gateway AppModule.
@Module({ imports: [AttendanceRpcModule, DatabaseModule] })
export class AttendanceAppModule {}
