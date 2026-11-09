import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { GatewayAttendanceModule } from '../gateway-attendance/gateway-attendance.module';

import { ScheduleGatewayController } from './schedule.gateway-controller';

@Module({
  imports: [AuthModule, GatewayAttendanceModule],
  controllers: [ScheduleGatewayController],
})
export class ScheduleGatewayModule {}
