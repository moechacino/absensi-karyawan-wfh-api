import { ClientTCP } from '@nestjs/microservices';
import type { ClientProxy } from '@nestjs/microservices';

import {
  RPC_REQUEST_BYTES,
  RPC_RESPONSE_BYTES,
} from '../attendance-rpc/rpc.config';
import type { RpcConfig } from '../attendance-rpc/rpc.config';
import { makeRpcFault } from '../attendance-rpc/rpc.fault';

export const RPC_CLIENT_FACTORY = Symbol('RPC_CLIENT_FACTORY');
export type RpcClient = Pick<ClientProxy, 'send' | 'close'>;
export type RpcClientFactory = () => RpcClient;

class AttendanceTcpClient extends ClientTCP {
  override close(): void {
    // Closing an attempt must also bound sockets still waiting to connect/drain.
    this.socket?.netSocket.destroy();
    super.close();
  }

  override handleError(): void {
    // The HTTP Problem mapper logs a safe failure code with the request ID.
  }
}

export function createRpcClient(config: RpcConfig): RpcClient {
  return new AttendanceTcpClient({
    host: config.host,
    port: config.port,
    maxBufferSize: RPC_RESPONSE_BYTES,
    maxSendBufferSize: RPC_REQUEST_BYTES,
    incompleteMessageTimeout: config.deadlineMs,
    messageReceiveTimeout: config.deadlineMs,
    deserializer: {
      deserialize(value: unknown) {
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          !('id' in value) ||
          typeof value.id !== 'string' ||
          value.id.length > 128
        ) {
          return {}; // No usable correlation ID: the finite deadline handles it.
        }

        if (Buffer.byteLength(JSON.stringify(value)) > RPC_RESPONSE_BYTES) {
          return {
            id: value.id,
            err: makeRpcFault('RPC_RESPONSE_TOO_LARGE'),
            isDisposed: true,
          };
        }

        return value;
      },
    },
  });
}
