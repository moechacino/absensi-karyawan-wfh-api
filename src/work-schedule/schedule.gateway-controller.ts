import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuthGuard, JsonBodyGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { HrGuard } from '../auth/hr.guard';
import { PaginationQuery } from '../http/parsing';
import { AttendanceClient } from '../gateway-attendance/attendance-client.service';
import { gatewayRpcContext } from '../gateway-attendance/rpc.context';
import { ATTENDANCE_PATTERNS as patterns } from '../attendance-rpc/rpc.contract';
import { ScheduleInput, TimeZonesInput } from '../attendance-rpc/rpc.inputs';
import type {
  WorkSchedule,
  ScheduleChanged,
  SchedulePreview,
  ScheduleHistoryPage,
  TimeZoneChoices,
} from '../attendance-rpc/rpc.responses';

@Controller()
@UseGuards(AuthGuard)
export class ScheduleGatewayController {
  constructor(private readonly client: AttendanceClient) {}

  @Get('work-schedule')
  get(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WorkSchedule> {
    return this.client.call(patterns.scheduleGet, {
      ...gatewayRpcContext(request, response),
      input: {},
    });
  }

  @Get('reference/time-zones')
  zones(
    @Query() input: TimeZonesInput,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TimeZoneChoices> {
    return this.client.call(patterns.timeZonesList, {
      ...gatewayRpcContext(request, response),
      input,
    });
  }

  @Post('hr/work-schedule/preview')
  @HttpCode(200)
  @UseGuards(HrGuard, JsonBodyGuard)
  preview(
    @Body() input: ScheduleInput,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SchedulePreview> {
    return this.client.call(patterns.schedulePreview, {
      ...gatewayRpcContext(request, response),
      input,
    });
  }

  @Get('hr/work-schedule/versions')
  @UseGuards(HrGuard)
  history(
    @Query() input: PaginationQuery,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ScheduleHistoryPage> {
    return this.client.call(patterns.scheduleVersions, {
      ...gatewayRpcContext(request, response),
      input,
    });
  }

  @Put('hr/work-schedule')
  @UseGuards(HrGuard, JsonBodyGuard)
  async change(
    @Body() input: ScheduleInput,
    @Headers('idempotency-key') key: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ScheduleChanged> {
    const result = await this.client.call(patterns.scheduleChange, {
      ...gatewayRpcContext(request, response),
      input,
      idempotencyKey: key,
    });
    response
      .status(result.status)
      .setHeader('Idempotency-Replayed', String(result.replayed));

    return result.body;
  }
}
