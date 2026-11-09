import { Controller, UseGuards } from '@nestjs/common';
import { Ctx, MessagePattern, Payload } from '@nestjs/microservices';
import type { TcpContext } from '@nestjs/microservices';
import { ATTENDANCE_PATTERNS as patterns } from '../attendance-rpc/rpc.contract';
import type { RpcCommandReply } from '../attendance-rpc/rpc.contract';
import type { Attendance, Home } from '../attendance-rpc/rpc.responses';
import { CheckOutInput, EmptyInput } from '../attendance-rpc/rpc.inputs';
import { StagedCheckInImage } from '../attendance-rpc/rpc.files';
import { checkInCommand } from '../attendance-rpc/check-in.command';
import { rpcActor } from '../attendance-rpc/rpc.guard';
import { AttendanceFileService } from '../attendance-files/attendance-file.service';
import { LocalCommandRunner } from '../idempotency/local-command-runner.service';
import { Clock } from '../runtime/clock';
import { AttendanceService } from './attendance.service';
import { AttendanceOwnerGuard } from './attendance-owner.guard';

@Controller()
export class AttendanceRpcController {
  constructor(
    private readonly service: AttendanceService,
    private readonly files: AttendanceFileService,
    private readonly commands: LocalCommandRunner,
    private readonly clock: Clock,
  ) {}

  @MessagePattern(patterns.homeGet)
  home(
    @Payload('input') _input: EmptyInput,
    @Ctx() context: TcpContext,
  ): Promise<Home> {
    return this.service.home(rpcActor(context).id);
  }

  @MessagePattern(patterns.checkIn)
  async checkIn(
    @Payload('input') _input: EmptyInput,
    @Payload('stagedImage') image: StagedCheckInImage,
    @Payload('fullUploadReceivedAt') receivedAt: string,
    @Payload('idempotencyKey') key: string,
    @Ctx() context: TcpContext,
  ): Promise<RpcCommandReply<Attendance>> {
    const actor = rpcActor(context);
    await this.files.verify(image, actor, receivedAt);
    const result = await this.commands.run(
      checkInCommand(actor.id, key, image, receivedAt),
      (manager) =>
        this.service.checkIn(actor.id, image, new Date(receivedAt), manager),
    );

    return { status: 201, body: result.body, replayed: result.replayed };
  }

  @MessagePattern(patterns.checkOut)
  @UseGuards(AttendanceOwnerGuard)
  async checkOut(
    @Payload('input') input: CheckOutInput,
    @Payload('idempotencyKey') key: string,
    @Ctx() context: TcpContext,
  ): Promise<RpcCommandReply<Attendance>> {
    const actor = rpcActor(context);
    const at = this.clock.now();
    const result = await this.commands.run(
      {
        actorId: actor.id,
        key,
        operation: 'checkOut',
        resourceId: input.attendanceId,
        input: { expectedVersion: input.expectedVersion },
        receivedAt: at,
      },
      (manager) =>
        this.service.checkOut(
          actor.id,
          input.attendanceId,
          input.expectedVersion,
          at,
          manager,
        ),
      { status: 200 },
    );

    return { status: 200, body: result.body, replayed: result.replayed };
  }
}
