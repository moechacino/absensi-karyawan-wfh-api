import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';
import type { RuntimeConfig } from '../runtime/runtime.config';
import { RuntimeDependencyError } from '../runtime/runtime.errors';
import { DATABASE_ENTITIES } from './entities';
import { OrganizationCodeLength1794127860128 } from './migrations/1794127860128-organization-code-length';
import { InitialSchema1794096000001 } from './migrations/1794096000001-initial-schema';

export function dataSourceOptions(config: RuntimeConfig): DataSourceOptions {
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
    entities: DATABASE_ENTITIES,
    migrations: [
      InitialSchema1794096000001,
      OrganizationCodeLength1794127860128,
    ],
    migrationsTableName: 'schema_migrations',
    migrationsTransactionMode: 'none',
    synchronize: false,
    migrationsRun: false,
    logging: false,
  };
}

export function databaseOptions(config: RuntimeConfig): TypeOrmModuleOptions {
  return {
    ...dataSourceOptions(config),
    autoLoadEntities: false,
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
    await source.initialize();
    return source;
  } catch {
    // Discard the driver error: it may include connection/user information.
    if (source.isInitialized) await source.destroy().catch(() => undefined);
    throw new RuntimeDependencyError('mysql');
  }
}
