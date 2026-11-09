import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { TcpContext } from '@nestjs/microservices';
import { rpcActor } from '../attendance-rpc/rpc.guard';
import { rpcFault } from '../attendance-rpc/rpc.fault';
import { uuid } from '../idempotency/idempotency.types';
import { AttendanceRepository } from './attendance.repository';

@Injectable()
export class AttendanceOwnerGuard implements CanActivate {
  constructor(private readonly repository: AttendanceRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rpc = context.switchToRpc();
    const id: unknown = rpc.getData<{ input: { attendanceId?: unknown } }>()
      .input.attendanceId;

    // Avoid undefined/invalid where values before the normal full DTO pipe runs.
    if (typeof id !== 'string' || !uuid.test(id)) {
      throw rpcFault('RPC_VALIDATION_FAILED');
    }

    if (
      !(await this.repository.owned(
        id,
        rpcActor(rpc.getContext<TcpContext>()).id,
      ))
    ) {
      throw rpcFault('NOT_FOUND');
    }

    return true;
  }
}
