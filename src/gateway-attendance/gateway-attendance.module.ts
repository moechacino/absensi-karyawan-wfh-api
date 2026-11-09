import { Module } from '@nestjs/common';

import { RuntimeModule } from '../runtime/runtime.module';
import { RPC_CONFIG, loadRpcConfig } from '../attendance-rpc/rpc.config';
import type { RpcConfig } from '../attendance-rpc/rpc.config';

import { AttendanceClient } from './attendance-client.service';
import { RPC_CLIENT_FACTORY, createRpcClient } from './rpc.client';

@Module({
  imports: [RuntimeModule],
  providers: [
    { provide: RPC_CONFIG, useFactory: loadRpcConfig },
    {
      provide: RPC_CLIENT_FACTORY,
      inject: [RPC_CONFIG],
      useFactory: (config: RpcConfig) => () => createRpcClient(config),
    },
    AttendanceClient,
  ],
  exports: [AttendanceClient],
})
export class GatewayAttendanceModule {}
