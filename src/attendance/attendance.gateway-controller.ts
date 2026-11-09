import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AuthGuard, JsonBodyGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { MultipartOnlyGuard } from '../http/parsing';
import { ProblemException } from '../http/problem';
import { AttendanceClient } from '../gateway-attendance/attendance-client.service';
import { gatewayRpcContext } from '../gateway-attendance/rpc.context';
import { ATTENDANCE_PATTERNS as patterns } from '../attendance-rpc/rpc.contract';
import { CheckoutVersionInput } from '../attendance-rpc/rpc.inputs';
import type { Attendance, Home } from '../attendance-rpc/rpc.responses';
import { RemoteImageService } from '../files/remote-image.service';
import { FileUploadInterceptor } from '../files/file-upload.interceptor';
import { UploadReceiptInterceptor } from '../files/upload-receipt.interceptor';
import type { UploadRequest } from '../files/upload-receipt.interceptor';
import { EmptyCheckInPipe } from './empty-check-in.pipe';

@Controller('me')
@UseGuards(AuthGuard)
export class AttendanceGatewayController {
  constructor(
    private readonly client: AttendanceClient,
    private readonly images: RemoteImageService,
  ) {}

  @Get('home')
  home(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Home> {
    return this.client.call(patterns.homeGet, {
      ...gatewayRpcContext(request, response),
      input: {},
    });
  }

  @Post('attendances/check-in')
  @UseGuards(MultipartOnlyGuard)
  @UseInterceptors(
    FileUploadInterceptor,
    FileInterceptor('photo', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    }),
    UploadReceiptInterceptor,
  )
  async checkIn(
    @Body(new EmptyCheckInPipe()) _input: Record<string, never>,
    @UploadedFile()
    photo:
      { buffer: Buffer; mimetype: string; originalname: string } | undefined,
    @Headers('idempotency-key') key: string,
    @Req() request: UploadRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Attendance> {
    if (!photo) {
      throw new ProblemException(422, 'INVALID_FILE', 'A photo is required');
    }

    const result = await this.images.checkIn(
      {
        bytes: photo.buffer,
        mimeType: photo.mimetype,
        fileName: photo.originalname,
      },
      request.actor.id,
      request.fullUploadReceivedAt,
      key,
      gatewayRpcContext(request, response),
    );
    response
      .status(result.status)
      .setHeader('Idempotency-Replayed', String(result.replayed));

    return result.body;
  }

  @Post('attendances/:attendanceId/check-out')
  @UseGuards(JsonBodyGuard)
  async checkOut(
    @Param('attendanceId', new ParseUUIDPipe()) attendanceId: string,
    @Body() input: CheckoutVersionInput,
    @Headers('idempotency-key') key: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Attendance> {
    const result = await this.client.call(patterns.checkOut, {
      ...gatewayRpcContext(request, response),
      input: { attendanceId, expectedVersion: input.expectedVersion },
      idempotencyKey: key,
    });
    response
      .status(result.status)
      .setHeader('Idempotency-Replayed', String(result.replayed));

    return result.body;
  }
}
