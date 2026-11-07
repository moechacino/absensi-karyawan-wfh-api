import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RUNTIME_CONFIG } from './runtime/runtime.config';
import type { RuntimeConfig } from './runtime/runtime.config';
import {
  RuntimeConfigurationError,
  RuntimeDependencyError,
} from './runtime/runtime.errors';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { abortOnError: false });
  try {
    const config = app.get<RuntimeConfig>(RUNTIME_CONFIG);
    app.enableShutdownHooks();
    await app.listen(config.app.port, config.app.host);
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  // Driver errors and configuration values must not be printed here.
  console.error(
    error instanceof RuntimeConfigurationError ||
      error instanceof RuntimeDependencyError
      ? error.message
      : 'API startup failed. Check database/storage availability and runtime configuration.',
  );
  process.exitCode = 1;
});
