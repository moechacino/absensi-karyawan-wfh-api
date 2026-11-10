import { Global, Inject, Injectable, Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { Clock, SystemClock } from './clock';
import { loadRuntimeConfig, RUNTIME_CONFIG } from './runtime.config';
import type { RuntimeConfig } from './runtime.config';
import { preparePrivateStorage } from './private-storage-check';
import { RuntimeDependencyError } from './runtime.errors';

@Injectable()
class StorageRootCheck implements OnModuleInit {
  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {}

  async onModuleInit(): Promise<void> {
    try {
      await preparePrivateStorage(this.config.storage.root);
    } catch {
      throw new RuntimeDependencyError('storage');
    }
  }
}

@Global()
@Module({
  providers: [
    { provide: RUNTIME_CONFIG, useFactory: loadRuntimeConfig },
    { provide: Clock, useClass: SystemClock },
    StorageRootCheck,
  ],
  exports: [RUNTIME_CONFIG, Clock],
})
export class RuntimeModule {}
