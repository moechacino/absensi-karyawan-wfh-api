import { Injectable, ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';

import { EmptyInput } from './rpc.inputs';
import { rpcFault } from './rpc.fault';

@Injectable()
export class RpcValidationPipe extends ValidationPipe {
  constructor() {
    super({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
      exceptionFactory: () => rpcFault('RPC_VALIDATION_FAILED'),
    });
  }

  override async transform(
    value: unknown,
    metadata: ArgumentMetadata,
  ): Promise<unknown> {
    if (metadata.metatype === EmptyInput) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length
      ) {
        throw rpcFault('RPC_VALIDATION_FAILED');
      }

      return value;
    }

    return super.transform(value, metadata);
  }
}
