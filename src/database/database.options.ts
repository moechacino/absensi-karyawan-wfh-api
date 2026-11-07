import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import type { RuntimeConfig } from '../runtime/runtime.config';
import { RuntimeDependencyError } from '../runtime/runtime.errors';

export function databaseOptions(config: RuntimeConfig): TypeOrmModuleOptions {
  return {
    type: 'mysql',
    host: config.database.host,
    port: config.database.port,
    database: config.database.name,
    username: config.database.username,
    password: config.database.password,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: ['DATE'],
    supportBigNumbers: true,
    bigNumberStrings: true,
    poolSize: config.database.poolSize,
    connectTimeout: config.database.connectTimeoutMs,
    multipleStatements: false,
    entities: [],
    autoLoadEntities: true,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    retryAttempts: 1,
    verboseRetryLog: false,
  };
}

export async function connectDatabase(
  options?: DataSourceOptions,
): Promise<DataSource> {
  if (!options) throw new Error('Database configuration is unavailable.');
  const source = new DataSource(options);
  try {
    return await source.initialize();
  } catch {
    // Discard the driver error: it may include connection/user information.
    if (source.isInitialized) await source.destroy().catch(() => undefined);
    throw new RuntimeDependencyError('mysql');
  }
}
