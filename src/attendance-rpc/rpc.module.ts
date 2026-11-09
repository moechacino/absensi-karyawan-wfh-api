import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';

import { AccessTokenModule } from '../auth/access-token.module';
import { RuntimeModule } from '../runtime/runtime.module';

import { RPC_CONFIG, loadRpcConfig } from './rpc.config';
import { RpcGuard } from './rpc.guard';
import { RpcFaultFilter } from './rpc.transport';
import { RpcValidationPipe } from './rpc.validation';

@Module({
  imports: [RuntimeModule, AccessTokenModule],
  providers: [
    { provide: RPC_CONFIG, useFactory: loadRpcConfig },
    { provide: APP_GUARD, useClass: RpcGuard },
    { provide: APP_PIPE, useClass: RpcValidationPipe },
    { provide: APP_FILTER, useClass: RpcFaultFilter },
  ],
  exports: [RPC_CONFIG],
})
export class AttendanceRpcModule {}
