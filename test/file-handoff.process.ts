import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  Controller,
  Injectable,
  Module,
  Post,
  Req,
  Res,
  Headers,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Ctx, MessagePattern, Payload } from '@nestjs/microservices';
import type { TcpContext } from '@nestjs/microservices';
import { FileInterceptor } from '@nestjs/platform-express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AttendanceRpcModule } from '../src/attendance-rpc/rpc.module';
import { DatabaseModule } from '../src/database/database.module';
import { AttendanceFileModule } from '../src/attendance-files/attendance-file.module';
import { AttendanceFileService } from '../src/attendance-files/attendance-file.service';
import { ATTENDANCE_PATTERNS as patterns } from '../src/attendance-rpc/rpc.contract';
import {
  StagedCheckInImage,
  CommandOutcomeInput,
} from '../src/attendance-rpc/rpc.files';
import { EmptyInput } from '../src/attendance-rpc/rpc.inputs';
import { rpcActor } from '../src/attendance-rpc/rpc.guard';
import { attendanceTcpOptions } from '../src/attendance-rpc/rpc.transport';
import { loadRpcConfig } from '../src/attendance-rpc/rpc.config';
import { checkInCommand } from '../src/attendance-rpc/check-in.command';
import {
  AttendanceEntity,
  ScheduleVersionEntity,
} from '../src/database/entities';
import { LocalCommandRunner } from '../src/idempotency/local-command-runner.service';
import { IdempotencyModule } from '../src/idempotency/idempotency.module';
import { AuthModule } from '../src/auth/auth.module';
import { AuthGuard } from '../src/auth/auth.guard';
import { FileModule } from '../src/files/file.module';
import { FileUploadInterceptor } from '../src/files/file-upload.interceptor';
import { UploadReceiptInterceptor } from '../src/files/upload-receipt.interceptor';
import type { UploadRequest } from '../src/files/upload-receipt.interceptor';
import { RemoteImageService } from '../src/files/remote-image.service';
import { AttendanceClient } from '../src/gateway-attendance/attendance-client.service';
import { GatewayAttendanceModule } from '../src/gateway-attendance/gateway-attendance.module';
import { gatewayRpcContext } from '../src/gateway-attendance/rpc.context';
import { configureHttp } from '../src/http/configure-http';
import { loadRuntimeConfig } from '../src/runtime/runtime.config';
import { ProblemException } from '../src/http/problem';

@Injectable()
class ProbeRepository {
  async write(
    manager: EntityManager,
    image: StagedCheckInImage,
    receivedAt: string,
  ): Promise<{ id: string; photo: { id: string }; checkInAt: string }> {
    const schedule = await manager.findOneByOrFail(ScheduleVersionEntity, {
      createdBy: image.ownerEmployeeId,
    });
    const id = randomUUID();
    await manager.insert(AttendanceEntity, {
      id,
      employeeId: image.ownerEmployeeId,
      workDate: '2026-11-09',
      scheduleVersionId: schedule.id,
      timeZone: schedule.timeZone,
      plannedStartAt: new Date('2026-11-09T01:00:00.000Z'),
      plannedEndAt: new Date('2026-11-09T09:00:00.000Z'),
      checkInAt: new Date(receivedAt),
      checkOutAt: null,
      punctuality: 'ON_TIME',
      photoFileId: image.id,
    });
    process.send?.({ event: 'written', image, receivedAt, pid: process.pid });

    if (image.fileName === 'delay.png') {
      await new Promise((resolve) => setTimeout(resolve, 1800));
    }

    if (image.fileName === 'rollback.png') {
      throw new ProblemException(400, 'INVALID_REQUEST', 'Rejected probe');
    }

    if (image.fileName === 'crash.png') {
      process.exit(86);
    }

    return { id, photo: { id: image.id }, checkInAt: receivedAt };
  }
}

// Test-only commit probes. No production check-in route/eligibility is introduced.
@Controller()
class CommitProbeController {
  constructor(
    private readonly files: AttendanceFileService,
    private readonly commands: LocalCommandRunner,
    private readonly repository: ProbeRepository,
  ) {}

  @MessagePattern(patterns.checkIn)
  async checkIn(
    @Payload('input') _input: EmptyInput,
    @Payload('stagedImage') image: StagedCheckInImage,
    @Payload('fullUploadReceivedAt') receivedAt: string,
    @Payload('idempotencyKey') key: string,
    @Ctx() context: TcpContext,
  ) {
    const actor = rpcActor(context);
    await this.files.verify(image, actor, receivedAt);
    const result = await this.commands.run(
      checkInCommand(actor.id, key, image, receivedAt),
      async (manager) => {
        await this.files.attach(manager, image);

        return this.repository.write(manager, image, receivedAt);
      },
    );

    if (!result.replayed && image.fileName === 'loss.png') {
      context.getSocketRef().netSocket.destroy();
    }

    if (!result.replayed && image.fileName === 'sql-unknown.png') {
      throw new Error('Simulated lost commit acknowledgement');
    }

    return result;
  }
}

@Module({
  imports: [
    AttendanceRpcModule,
    DatabaseModule,
    AttendanceFileModule,
    IdempotencyModule,
  ],
  controllers: [CommitProbeController],
  providers: [ProbeRepository],
})
class AttendanceProbeModule {}

@Controller('__handoff')
@UseGuards(AuthGuard)
class GatewayProbeController {
  constructor(
    private readonly images: RemoteImageService,
    private readonly attendance: AttendanceClient,
  ) {}

  @Post('check-in')
  @UseInterceptors(
    FileUploadInterceptor,
    FileInterceptor('photo'),
    UploadReceiptInterceptor,
  )
  checkIn(
    @UploadedFile()
    photo: { buffer: Buffer; mimetype: string; originalname: string },
    @Headers('idempotency-key') key: string,
    @Req() request: UploadRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.images.checkIn(
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
  }

  @Post('outcome')
  outcome(
    @Body() input: CommandOutcomeInput,
    @Req() request: UploadRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.attendance.call(patterns.commandOutcome, {
      ...gatewayRpcContext(request, response),
      input,
    });
  }
}

@Module({
  imports: [AppModule, AuthModule, FileModule, GatewayAttendanceModule],
  controllers: [GatewayProbeController],
})
class GatewayProbeModule {}

function countQueries(source: DataSource): void {
  source.logger.logQuery = (query: string) => {
    if (/^SELECT\b/i.test(query)) {
      process.send?.({
        event: 'query',
        attendanceRead: /\battendances\b/.test(query),
        fileRead: /\bfile_objects\b/.test(query),
      });
    }
  };
}

async function main(): Promise<void> {
  if (
    process.env.NODE_ENV !== 'test' ||
    !process.env.DB_NAME?.endsWith('_test')
  ) {
    throw new Error('Disposable test environment required');
  }

  if (process.env.HANDOFF_PROCESS === 'attendance') {
    const app = await NestFactory.createMicroservice(AttendanceProbeModule, {
      ...attendanceTcpOptions(loadRpcConfig()),
      logger: false,
    });
    countQueries(app.get(DataSource));
    app.enableShutdownHooks();
    await app.listen();
  } else {
    const app = await NestFactory.create<NestExpressApplication>(
      GatewayProbeModule,
      { logger: false },
    );
    configureHttp(app, loadRuntimeConfig());
    countQueries(app.get(DataSource));
    app.enableShutdownHooks();
    await app.listen(Number(process.env.PORT), '127.0.0.1');
  }

  process.send?.({ event: 'ready', pid: process.pid });
}

void main().catch(() => {
  console.error('File handoff test process failed to start.');
  process.exitCode = 1;
});
