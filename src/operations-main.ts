import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { IdempotencyService } from './idempotency/idempotency.service';
import { OperationsModule } from './operations/operations.module';
import { operationsCommand } from './operations/operations.input';
import { readProvisionInput } from './operations/provision.prompt';
import { ProvisionService } from './operations/provision.service';
import { loadRuntimeConfig } from './runtime/runtime.config';
import { preparePrivateStorage } from './runtime/private-storage-check';

async function main(): Promise<void> {
  const { command, limit } = operationsCommand(process.argv.slice(2));
  const input =
    command === 'cleanup-receipts' ? undefined : await readProvisionInput();
  // Check disk before context initialization can allocate a database pool.
  await preparePrivateStorage(loadRuntimeConfig().storage.root);
  const app = await NestFactory.createApplicationContext(OperationsModule, {
    logger: false,
    abortOnError: false,
  });

  try {
    const result = input
      ? await app
          .get(ProvisionService)
          .firstHrd(input, command === 'seed-development')
      : { deleted: await app.get(IdempotencyService).cleanupExpired(limit!) };
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
  }
}

void main().catch((e: any) => {
  // Never echo stdin, arguments, driver errors, credentials or paths.
  console.error(
    'Operation failed. Check command/confirmation, input, empty-installation requirement, environment and database/storage availability.',
    e,
  );
  process.exitCode = 1;
});
