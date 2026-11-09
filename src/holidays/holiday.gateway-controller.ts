import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { AuthGuard, JsonBodyGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { HrGuard } from '../auth/hr.guard';
import { AttendanceClient } from '../gateway-attendance/attendance-client.service';
import { gatewayRpcContext } from '../gateway-attendance/rpc.context';
import { ATTENDANCE_PATTERNS as patterns } from '../attendance-rpc/rpc.contract';
import { HolidayChangeInput } from '../attendance-rpc/rpc.inputs';
import type {
  HolidayCalendar,
  HolidayChanged,
  ChangeImpact,
} from '../attendance-rpc/rpc.responses';

import { HolidayYearQuery } from './holiday.query';

@Controller()
@UseGuards(AuthGuard)
export class HolidayGatewayController {
  constructor(private readonly client: AttendanceClient) {}

  @Get('holidays')
  get(
    @Query() input: HolidayYearQuery,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<HolidayCalendar> {
    return this.client.call(patterns.holidaysGet, {
      ...gatewayRpcContext(request, response),
      input,
    });
  }

  @Post('hr/holidays/preview')
  @HttpCode(200)
  @UseGuards(HrGuard, JsonBodyGuard)
  preview(
    @Body() input: HolidayChangeInput,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ChangeImpact> {
    return this.client.call(patterns.holidaysPreview, {
      ...gatewayRpcContext(request, response),
      input,
    });
  }

  @Post('hr/holidays/changes')
  @HttpCode(200)
  @UseGuards(HrGuard, JsonBodyGuard)
  async change(
    @Body() input: HolidayChangeInput,
    @Headers('idempotency-key') key: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<HolidayChanged> {
    const result = await this.client.call(patterns.holidaysChange, {
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
