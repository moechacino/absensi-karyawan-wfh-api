import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload } from '@nestjs/microservices';
import type { TcpContext } from '@nestjs/microservices';

import { ATTENDANCE_PATTERNS as patterns } from '../attendance-rpc/rpc.contract';
import type { RpcCommandReply } from '../attendance-rpc/rpc.contract';
import {
  EmptyInput,
  PageInput,
  ScheduleInput,
  TimeZonesInput,
} from '../attendance-rpc/rpc.inputs';
import type {
  ScheduleChanged,
  WorkSchedule,
  SchedulePreview,
  ScheduleHistoryPage,
  TimeZoneChoices,
} from '../attendance-rpc/rpc.responses';
import { rpcActor } from '../attendance-rpc/rpc.guard';
import { LocalCommandRunner } from '../idempotency/local-command-runner.service';

import { ScheduleService } from './schedule.service';
import { TimeZonesService } from './time-zones.service';
import { scheduleCommand } from './schedule.command';

@Controller()
export class ScheduleRpcController {
  constructor(
    private readonly service: ScheduleService,
    private readonly timeZones: TimeZonesService,
    private readonly commands: LocalCommandRunner,
  ) {}

  @MessagePattern(patterns.scheduleGet)
  get(@Payload('input') _input: EmptyInput): Promise<WorkSchedule> {
    return this.service.get();
  }

  @MessagePattern(patterns.timeZonesList)
  zones(@Payload('input') input: TimeZonesInput): TimeZoneChoices {
    return this.timeZones.list(input);
  }

  @MessagePattern(patterns.schedulePreview)
  preview(@Payload('input') input: ScheduleInput): Promise<SchedulePreview> {
    return this.service.preview(input);
  }

  @MessagePattern(patterns.scheduleVersions)
  history(@Payload('input') input: PageInput): Promise<ScheduleHistoryPage> {
    return this.service.history(input);
  }

  @MessagePattern(patterns.scheduleChange)
  async change(
    @Payload('input') input: ScheduleInput,
    @Payload('idempotencyKey') key: string,
    @Ctx() context: TcpContext,
  ): Promise<RpcCommandReply<ScheduleChanged>> {
    const actor = rpcActor(context);
    const canonical = scheduleCommand(input);
    const result = await this.commands.run(
      {
        actorId: actor.id,
        operation: 'changeWorkSchedule',
        key,
        input: canonical,
      },
      (manager) => this.service.change(canonical, actor.id, manager),
      { status: 200 },
    );

    return { status: 200, body: result.body, replayed: result.replayed };
  }
}
