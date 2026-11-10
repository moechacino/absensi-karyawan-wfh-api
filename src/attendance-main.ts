import { NestFactory } from '@nestjs/core';
import type { MicroserviceOptions } from '@nestjs/microservices';

import { AttendanceAppModule } from './attendance-app.module';
import { loadRpcConfig } from './attendance-rpc/rpc.config';
import { attendanceTcpOptions } from './attendance-rpc/rpc.transport';
import {
  RuntimeConfigurationError,
  RuntimeDependencyError,
} from './runtime/runtime.errors';

async function bootstrap() {
  const config = loadRpcConfig();
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AttendanceAppModule,
    {
      ...attendanceTcpOptions(config),
      abortOnError: false,
      logger: false,
    },
  );

  try {
    app.enableShutdownHooks();
    await app.listen();
    console.log('Attendance ready.');
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  console.error(
    error instanceof RuntimeConfigurationError ||
      error instanceof RuntimeDependencyError
      ? error.message
      : 'Attendance startup failed. Check TCP port, database/storage availability and runtime configuration.',
  );

  process.exitCode = 1;
});
