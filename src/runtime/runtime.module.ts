import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { Global, Inject, Injectable, Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { Clock, SystemClock } from './clock';
import { loadRuntimeConfig, RUNTIME_CONFIG } from './runtime.config';
import type { RuntimeConfig } from './runtime.config';
import { RuntimeDependencyError } from './runtime.errors';

@Injectable()
class StorageRootCheck implements OnModuleInit {
  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {}

  async onModuleInit(): Promise<void> {
    try {
      await mkdir(this.config.storage.root, { recursive: true, mode: 0o700 });
      await access(
        this.config.storage.root,
        constants.R_OK | constants.W_OK | constants.X_OK,
      );
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
