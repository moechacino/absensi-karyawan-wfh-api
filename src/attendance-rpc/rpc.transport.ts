import { Catch } from '@nestjs/common';
import type { RpcExceptionFilter } from '@nestjs/common';
import { Transport } from '@nestjs/microservices';
import type { TcpOptions } from '@nestjs/microservices';
import { throwError } from 'rxjs';

import { RPC_REQUEST_BYTES, RPC_RESPONSE_BYTES } from './rpc.config';
import type { RpcConfig } from './rpc.config';
import { rpcFault } from './rpc.fault';
import { toRpcFault } from './rpc.fault-mapper';

@Catch()
export class RpcFaultFilter implements RpcExceptionFilter {
  catch(error: unknown) {
    return throwError(() => toRpcFault(error));
  }
}

export function boundedResponse(packet: {
  id?: string;
  response?: unknown;
  err?: unknown;
  isDisposed?: boolean;
}) {
  try {
    if (Buffer.byteLength(JSON.stringify(packet)) <= RPC_RESPONSE_BYTES) {
      return packet;
    }
  } catch {
    return { id: packet.id, err: toRpcFault(undefined), isDisposed: true };
  }

  return {
    id: packet.id,
    err: rpcFault('RPC_RESPONSE_TOO_LARGE').getError(),
    isDisposed: true,
  };
}

export function attendanceTcpOptions(config: RpcConfig): TcpOptions {
  return {
    transport: Transport.TCP,
    options: {
      host: config.host,
      port: config.port,
      retryAttempts: 0,
      maxBufferSize: RPC_REQUEST_BYTES,
      maxSendBufferSize: RPC_RESPONSE_BYTES,
      incompleteMessageTimeout: 5000,
      messageReceiveTimeout: 10000,
      drainTimeout: 5000,
      serializer: { serialize: boundedResponse },
    },
  };
}
