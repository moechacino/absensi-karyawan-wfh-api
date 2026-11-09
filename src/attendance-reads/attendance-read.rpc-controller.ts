import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload } from '@nestjs/microservices';
import type { TcpContext } from '@nestjs/microservices';
import { ATTENDANCE_PATTERNS as patterns } from '../attendance-rpc/rpc.contract';
import {
  AttendanceDaysInput,
  AttendanceRecordInput,
  MonitoringInput,
} from '../attendance-rpc/rpc.inputs';
import type {
  Attendance,
  AttendanceDayPage,
  MonitoringPage,
} from '../attendance-rpc/rpc.responses';
import { rpcActor } from '../attendance-rpc/rpc.guard';
import { AttendanceReadService } from './attendance-read.service';

@Controller()
export class AttendanceReadRpcController {
  constructor(private readonly service: AttendanceReadService) {}

  @MessagePattern(patterns.daysList)
  history(
    @Payload('input') input: AttendanceDaysInput,
    @Ctx() context: TcpContext,
  ): Promise<AttendanceDayPage> {
    return this.service.history(rpcActor(context).id, input);
  }

  @MessagePattern(patterns.recordGet)
  own(
    @Payload('input') input: AttendanceRecordInput,
    @Ctx() context: TcpContext,
  ): Promise<Attendance> {
    return this.service.detail(input.attendanceId, rpcActor(context).id);
  }

  @MessagePattern(patterns.monitoringList)
  monitor(@Payload('input') input: MonitoringInput): Promise<MonitoringPage> {
    return this.service.monitor(input);
  }

  @MessagePattern(patterns.hrRecordGet)
  hr(@Payload('input') input: AttendanceRecordInput): Promise<Attendance> {
    return this.service.detail(input.attendanceId);
  }
}
