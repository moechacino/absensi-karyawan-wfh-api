import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadRuntimeConfig } from '../runtime/runtime.config';
import type { RuntimeConfig } from '../runtime/runtime.config';
import { dataSourceOptions } from './database.options';

export function createDataSource(
  config: RuntimeConfig = loadRuntimeConfig(),
): DataSource {
  return new DataSource(dataSourceOptions(config));
}
