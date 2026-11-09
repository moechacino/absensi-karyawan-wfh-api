import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload } from '@nestjs/microservices';
import type { TcpContext } from '@nestjs/microservices';
import { ATTENDANCE_PATTERNS as patterns } from '../attendance-rpc/rpc.contract';
import {
  CommandOutcomeInput,
  FileAccessInput,
} from '../attendance-rpc/rpc.files';
import type {
  CommandOutcome,
  FileReadDescriptor,
} from '../attendance-rpc/rpc.files';
import { rpcActor } from '../attendance-rpc/rpc.guard';
import { AttendanceFileService } from './attendance-file.service';

@Controller()
export class AttendanceFileRpcController {
  constructor(private readonly service: AttendanceFileService) {}

  @MessagePattern(patterns.fileAccess)
  readable(
    @Payload('input') input: FileAccessInput,
    @Ctx() context: TcpContext,
  ): Promise<FileReadDescriptor> {
    return this.service.readable(input.fileId, rpcActor(context));
  }

  @MessagePattern(patterns.commandOutcome)
  outcome(
    @Payload('input') input: CommandOutcomeInput,
    @Ctx() context: TcpContext,
  ): Promise<CommandOutcome> {
    return this.service.outcome(rpcActor(context), input);
  }
}
