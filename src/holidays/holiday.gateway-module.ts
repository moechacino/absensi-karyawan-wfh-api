import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { GatewayAttendanceModule } from '../gateway-attendance/gateway-attendance.module';

import { HolidayGatewayController } from './holiday.gateway-controller';

@Module({
  imports: [AuthModule, GatewayAttendanceModule],
  controllers: [HolidayGatewayController],
})
export class HolidayGatewayModule {}
