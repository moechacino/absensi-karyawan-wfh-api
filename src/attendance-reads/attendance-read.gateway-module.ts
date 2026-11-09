import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GatewayAttendanceModule } from '../gateway-attendance/gateway-attendance.module';
import { AttendanceReadGatewayController } from './attendance-read.gateway-controller';

@Module({
  imports: [AuthModule, GatewayAttendanceModule],
  controllers: [AttendanceReadGatewayController],
})
export class AttendanceReadGatewayModule {}
