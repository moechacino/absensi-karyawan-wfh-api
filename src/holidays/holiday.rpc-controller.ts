import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload } from '@nestjs/microservices';
import type { TcpContext } from '@nestjs/microservices';

import { ATTENDANCE_PATTERNS as patterns } from '../attendance-rpc/rpc.contract';
import type { RpcCommandReply } from '../attendance-rpc/rpc.contract';
import {
  HolidayYearInput,
  HolidayChangeInput,
} from '../attendance-rpc/rpc.inputs';
import type {
  HolidayCalendar,
  ChangeImpact,
  HolidayChanged,
} from '../attendance-rpc/rpc.responses';
import { rpcActor } from '../attendance-rpc/rpc.guard';
import { LocalCommandRunner } from '../idempotency/local-command-runner.service';

import { HolidayService } from './holiday.service';
import { holidayCommand } from './holiday.rules';

@Controller()
export class HolidayRpcController {
  constructor(
    private readonly service: HolidayService,
    private readonly commands: LocalCommandRunner,
  ) {}

  @MessagePattern(patterns.holidaysGet)
  get(@Payload('input') input: HolidayYearInput): Promise<HolidayCalendar> {
    return this.service.get(input.year);
  }

  @MessagePattern(patterns.holidaysPreview)
  preview(@Payload('input') input: HolidayChangeInput): Promise<ChangeImpact> {
    return this.service.preview(input);
  }

  @MessagePattern(patterns.holidaysChange)
  async change(
    @Payload('input') input: HolidayChangeInput,
    @Payload('idempotencyKey') key: string,
    @Ctx() context: TcpContext,
  ): Promise<RpcCommandReply<HolidayChanged>> {
    const actor = rpcActor(context);
    const canonical = holidayCommand(input);
    const result = await this.commands.run(
      {
        actorId: actor.id,
        operation: 'changeHolidayCalendar',
        key,
        input: canonical,
      },
      (manager) => this.service.change(canonical, manager),
      { status: 200 },
    );

    return { status: 200, body: result.body, replayed: result.replayed };
  }
}
