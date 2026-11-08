import { Global, Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { RUNTIME_CONFIG } from '../runtime/runtime.config';
import type { RuntimeConfig } from '../runtime/runtime.config';

@Global()
@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [RUNTIME_CONFIG],
      useFactory: (config: RuntimeConfig) => ({
        limits: {
          fileSize: config.storage.maxFileBytes,
          files: 1,
          fields: 16,
          parts: 17,
          fieldNameSize: 64,
          fieldSize: 16 * 1024,
          headerPairs: 64,
          fieldNestingDepth: 0,
          fieldArrayIndexLimit: 0,
        },
      }),
    }),
  ],
  exports: [MulterModule],
})
export class HttpModule {}
