import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { HrGuard } from '../auth/hr.guard';
import { AttendanceClient } from '../gateway-attendance/attendance-client.service';
import { gatewayRpcContext } from '../gateway-attendance/rpc.context';
import { ATTENDANCE_PATTERNS as patterns } from '../attendance-rpc/rpc.contract';
import type {
  Attendance,
  AttendanceDayPage,
  MonitoringPage,
} from '../attendance-rpc/rpc.responses';
import {
  AttendanceHistoryQuery,
  AttendanceMonitoringQuery,
} from './attendance-read.query';

@Controller()
@UseGuards(AuthGuard)
export class AttendanceReadGatewayController {
  constructor(private readonly client: AttendanceClient) {}

  @Get('me/attendance-days')
  history(
    @Query() input: AttendanceHistoryQuery,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AttendanceDayPage> {
    return this.client.call(patterns.daysList, {
      ...gatewayRpcContext(request, response),
      input,
    });
  }

  @Get('me/attendances/:attendanceId')
  own(
    @Param('attendanceId', new ParseUUIDPipe()) attendanceId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Attendance> {
    return this.client.call(patterns.recordGet, {
      ...gatewayRpcContext(request, response),
      input: { attendanceId },
    });
  }

  @Get('hr/attendance-days')
  @UseGuards(HrGuard)
  monitor(
    @Query() input: AttendanceMonitoringQuery,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MonitoringPage> {
    return this.client.call(patterns.monitoringList, {
      ...gatewayRpcContext(request, response),
      input,
    });
  }

  @Get('hr/attendances/:attendanceId')
  @UseGuards(HrGuard)
  hr(
    @Param('attendanceId', new ParseUUIDPipe()) attendanceId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Attendance> {
    return this.client.call(patterns.hrRecordGet, {
      ...gatewayRpcContext(request, response),
      input: { attendanceId },
    });
  }
}
