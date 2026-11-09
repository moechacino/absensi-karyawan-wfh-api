import { RpcException } from '@nestjs/microservices';

export type RpcFaultCode =
  | 'RPC_INVALID_ENVELOPE'
  | 'RPC_UNSUPPORTED_VERSION'
  | 'RPC_UNAUTHORIZED'
  | 'RPC_FORBIDDEN'
  | 'RPC_VALIDATION_FAILED'
  | 'RPC_RESPONSE_TOO_LARGE'
  | 'RPC_INTERNAL_ERROR';

export interface RpcFault {
  version: 1;
  code: RpcFaultCode;
  message: string;
}

export function rpcFault(code: RpcFaultCode): RpcException {
  return new RpcException({
    version: 1,
    code,
    message: 'Attendance RPC request failed.',
  } satisfies RpcFault);
}
