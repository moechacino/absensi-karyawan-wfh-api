import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Ctx, MessagePattern, Payload } from '@nestjs/microservices';
import type { TcpContext } from '@nestjs/microservices';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';

import { AppModule } from '../src/app.module';
import { AttendanceRpcModule } from '../src/attendance-rpc/rpc.module';
import { DatabaseModule } from '../src/database/database.module';
import { AuthModule } from '../src/auth/auth.module';
import { AuthGuard } from '../src/auth/auth.guard';
import type { AuthenticatedRequest } from '../src/auth/auth.guard';
import { AttendanceEntity } from '../src/database/entities';
import { ProblemException } from '../src/http/problem';
import { IdempotencyModule } from '../src/idempotency/idempotency.module';
import { LocalCommandRunner } from '../src/idempotency/local-command-runner.service';
import { uuid } from '../src/idempotency/idempotency.types';
import { Clock } from '../src/runtime/clock';
import { ATTENDANCE_PATTERNS as patterns } from '../src/attendance-rpc/rpc.contract';
import { rpcActor } from '../src/attendance-rpc/rpc.guard';
import {
  AttendanceRecordInput,
  CheckOutInput,
  ScheduleInput,
  TimeZonesInput,
} from '../src/attendance-rpc/rpc.inputs';
import { AttendanceClient } from '../src/gateway-attendance/attendance-client.service';
import { GatewayAttendanceModule } from '../src/gateway-attendance/gateway-attendance.module';
import { gatewayRpcContext } from '../src/gateway-attendance/rpc.context';

export class RpcTestClock extends Clock {
  offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
}

@Injectable()
export class ProbeState {
  dropNextReply = false;
  readDelayMs = 0;
  receivedRequestId?: string;
  receivedKey?: string;
}

@Injectable()
class ProbeRepository {
  constructor(private readonly source: DataSource) {}

  read(id: string, manager = this.source.manager) {
    return manager.findOneBy(AttendanceEntity, { id });
  }

  async increment(id: string, manager: EntityManager) {
    await manager.increment(AttendanceEntity, { id }, 'version', 1);
  }
}

@Injectable()
class ProbeOwnerGuard implements CanActivate {
  constructor(private readonly repository: ProbeRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rpc = context.switchToRpc();
    const input = rpc.getData<{ input?: { attendanceId?: unknown } }>().input;

    if (
      typeof input?.attendanceId !== 'string' ||
      !uuid.test(input.attendanceId)
    ) {
      return true; // The normal DTO pipe reports invalid input without querying.
    }

    const record = await this.repository.read(input.attendanceId);
    const actor = rpcActor(rpc.getContext<TcpContext>());

    if (
      !record ||
      (actor.id !== record.employeeId &&
        !(
          actor.role === 'HRD' &&
          rpc.getContext<TcpContext>().getPattern() === patterns.hrRecordGet
        ))
    ) {
      throw new ProblemException(404, 'NOT_FOUND', 'Attendance not found');
    }

    return true;
  }
}

@Injectable()
class ProbeService {
  constructor(private readonly repository: ProbeRepository) {}

  async change(input: CheckOutInput, manager: EntityManager) {
    const record = await this.repository.read(input.attendanceId, manager);

    if (!record || record.version !== input.expectedVersion) {
      throw new ProblemException(409, 'VERSION_CONFLICT', 'Version conflict', {
        details: {
          expectedVersion: input.expectedVersion,
          actualVersion: record?.version ?? 0,
        },
      });
    }

    await this.repository.increment(record.id, manager);

    return { id: record.id, version: record.version + 1 };
  }
}

// Foundation probes only: these modules are never imported by production entry points.
@Controller()
class RpcBoundaryProbe {
  constructor(
    private readonly runner: LocalCommandRunner,
    private readonly service: ProbeService,
    private readonly state: ProbeState,
  ) {}

  @MessagePattern(patterns.timeZonesList)
  async read(
    @Payload('input') input: TimeZonesInput,
    @Payload('requestId') requestId: string,
  ) {
    this.state.receivedRequestId = requestId;

    if (input.q === 'secret') {
      throw new Error('private-SQL-JWT-path-marker');
    }

    if (this.state.readDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.state.readDelayMs),
      );
    }

    return { items: [] };
  }

  @MessagePattern(patterns.recordGet)
  @UseGuards(ProbeOwnerGuard)
  record(@Payload('input') input: AttendanceRecordInput) {
    return { id: input.attendanceId };
  }

  @MessagePattern(patterns.hrRecordGet)
  @UseGuards(ProbeOwnerGuard)
  hrRecord(@Payload('input') input: AttendanceRecordInput) {
    return { id: input.attendanceId };
  }

  @MessagePattern(patterns.scheduleChange)
  hr(@Payload('input') input: ScheduleInput) {
    return { expectedVersion: input.expectedVersion };
  }

  @MessagePattern(patterns.checkOut)
  @UseGuards(ProbeOwnerGuard)
  async write(
    @Payload('input') input: CheckOutInput,
    @Payload('requestId') requestId: string,
    @Payload('idempotencyKey') key: string,
    @Ctx() context: TcpContext,
  ) {
    this.state.receivedRequestId = requestId;
    this.state.receivedKey = key;
    const actor = rpcActor(context);
    const result = await this.runner.run(
      {
        actorId: actor.id,
        operation: 'checkOut',
        key,
        input: { expectedVersion: input.expectedVersion },
        resourceId: input.attendanceId,
      },
      (manager) => this.service.change(input, manager),
      { status: 200 },
    );

    if (this.state.dropNextReply) {
      this.state.dropNextReply = false;
      context.getSocketRef().netSocket.destroy();
    }

    return result;
  }
}

@Controller('rpc-probe')
@UseGuards(AuthGuard)
class GatewayBoundaryProbe {
  constructor(private readonly client: AttendanceClient) {}

  @Get('read')
  read(
    @Query() input: TimeZonesInput,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.client.call(patterns.timeZonesList, {
      ...gatewayRpcContext(request, response),
      input,
    });
  }

  @Post('write')
  async write(
    @Body() input: CheckOutInput,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.client.call(patterns.checkOut, {
      ...gatewayRpcContext(request, response),
      input,
      idempotencyKey: request.get('Idempotency-Key')!,
    });
    response
      .status(result.status)
      .setHeader('Idempotency-Replayed', String(result.replayed));

    return result.body;
  }

  @Get('hr-record/:attendanceId')
  hrRecord(
    @Param('attendanceId') attendanceId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.client.call(patterns.hrRecordGet, {
      ...gatewayRpcContext(request, response),
      input: { attendanceId },
    });
  }

  @Get('record/:attendanceId')
  record(
    @Param('attendanceId') attendanceId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.client.call(patterns.recordGet, {
      ...gatewayRpcContext(request, response),
      input: { attendanceId },
    });
  }
}

@Module({
  imports: [AttendanceRpcModule, DatabaseModule, IdempotencyModule],
  controllers: [RpcBoundaryProbe],
  providers: [ProbeState, ProbeRepository, ProbeService, ProbeOwnerGuard],
})
export class RpcBoundaryProbeModule {}

@Module({
  imports: [AppModule, AuthModule, GatewayAttendanceModule],
  controllers: [GatewayBoundaryProbe],
})
export class GatewayBoundaryProbeModule {}
