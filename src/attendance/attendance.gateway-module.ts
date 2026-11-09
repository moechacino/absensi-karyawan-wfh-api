import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FileModule } from '../files/file.module';
import { GatewayAttendanceModule } from '../gateway-attendance/gateway-attendance.module';
import { AttendanceGatewayController } from './attendance.gateway-controller';

@Module({
  imports: [AuthModule, FileModule, GatewayAttendanceModule],
  controllers: [AttendanceGatewayController],
})
export class AttendanceGatewayModule {}
