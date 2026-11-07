import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RUNTIME_CONFIG } from '../runtime/runtime.config';
import type { RuntimeConfig } from '../runtime/runtime.config';
import { RuntimeModule } from '../runtime/runtime.module';
import { connectDatabase, databaseOptions } from './database.options';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [RuntimeModule],
      inject: [RUNTIME_CONFIG],
      useFactory: (config: RuntimeConfig) => databaseOptions(config),
      dataSourceFactory: connectDatabase,
    }),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
