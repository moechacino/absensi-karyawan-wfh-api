import { parseRuntimeConfig } from '../src/runtime/runtime.config';

export function fileConfig(root = '/tmp/wfh-files-unit') {
  return parseRuntimeConfig({
    NODE_ENV: 'test',
    DB_HOST: 'localhost',
    DB_NAME: 'unused_test',
    DB_USERNAME: 'unused',
    DB_PASSWORD: 'unused',
    JWT_SECRET: 'test-signing-secret-at-least-32-bytes',
    JWT_ISSUER: 'test-api',
    JWT_AUDIENCE: 'test-web',
    STORAGE_ROOT: root,
  });
}
