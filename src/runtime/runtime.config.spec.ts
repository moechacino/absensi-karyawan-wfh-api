import { resolve } from 'node:path';
import { parseRuntimeConfig } from './runtime.config';
import { RuntimeConfigurationError } from './runtime.errors';

const validEnvironment = {
  NODE_ENV: 'test',
  DB_HOST: '127.0.0.1',
  DB_NAME: 'absensi_test',
  DB_USERNAME: 'absensi_test',
  DB_PASSWORD: 'database-test-only',
  JWT_SECRET: 'a-test-only-secret-with-at-least-32-bytes',
  JWT_ISSUER: 'absensi-test',
  JWT_AUDIENCE: 'absensi-web-test',
  STORAGE_ROOT: '../private-files',
};

describe('runtime configuration', () => {
  it('parses independent browser allowlists and pins policy defaults without changing input', () => {
    const env = {
      ...validEnvironment,
      CORS_ORIGINS: 'https://WEB.example:443,https://WEB.example',
      CSRF_TRUSTED_ORIGINS: 'http://localhost:5173',
    };
    const config = parseRuntimeConfig(env, '/application/api');
    expect(config.browser.corsOrigins).toEqual(['https://web.example']);
    expect(config.browser.csrfTrustedOrigins).toEqual([
      'http://localhost:5173',
    ]);
    expect(config.storage.root).toBe(resolve('/application/private-files'));
    expect(config.jwt.accessTtlSeconds).toBe(28800);
    expect(config.policy.idempotencyRetentionSeconds).toBe(86400);
    expect(Object.isFrozen(config)).toBe(true);
    expect(env.CORS_ORIGINS).toContain('WEB.example');
  });

  it.each(['', '0', '-1', '01', '3000.5', 'Infinity', '65536', ' 3000'])(
    'rejects a noncanonical/out-of-range port: %p',
    (port) => {
      expect(() =>
        parseRuntimeConfig({ ...validEnvironment, PORT: port }),
      ).toThrow('PORT');
    },
  );

  it.each([
    '*',
    'https://*.example.test',
    'https://site.example/path',
    'https://site.example/',
    'https://site.example?token=private',
    'https://user:private@site.example',
    'https://@site.example',
    'file:///tmp/files',
  ])('rejects unsafe origin configuration: %p', (origin) => {
    expect(() =>
      parseRuntimeConfig({ ...validEnvironment, CORS_ORIGINS: origin }),
    ).toThrow('CORS_ORIGINS');
  });

  it('rejects HTTP browser origins in production', () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnvironment,
        NODE_ENV: 'production',
        CSRF_TRUSTED_ORIGINS: 'http://example.test',
      }),
    ).toThrow('CSRF_TRUSTED_ORIGINS');
  });

  it.each(['.', './src/private', './public', '/application/api/files'])(
    'keeps local bytes outside the application: %p',
    (storage) => {
      expect(() =>
        parseRuntimeConfig(
          { ...validEnvironment, STORAGE_ROOT: storage },
          '/application/api',
        ),
      ).toThrow('STORAGE_ROOT');
    },
  );

  it('aggregates invalid settings without exposing secret values', () => {
    const env = {
      ...validEnvironment,
      DB_PASSWORD: '',
      JWT_SECRET: 'secret-marker-not-to-log',
      DB_HOST: '',
      JWT_ALGORITHM: 'none',
    };
    let error: unknown;
    try {
      parseRuntimeConfig(env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RuntimeConfigurationError);
    expect((error as Error).message).toContain('DB_PASSWORD');
    expect((error as Error).message).toContain('DB_HOST');
    expect((error as Error).message).toContain('JWT_SECRET');
    expect((error as Error).message).not.toContain(env.JWT_SECRET);
  });

  it('rejects accidental policy weakening and placeholder secrets', () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnvironment,
        IDEMPOTENCY_RETENTION_SECONDS: '86399',
      }),
    ).toThrow('IDEMPOTENCY_RETENTION_SECONDS');
    expect(() =>
      parseRuntimeConfig({ ...validEnvironment, MAX_FILE_BYTES: '5242881' }),
    ).toThrow('MAX_FILE_BYTES');
    expect(() =>
      parseRuntimeConfig({
        ...validEnvironment,
        JWT_SECRET: 'REPLACE_WITH_A_SECRET_OF_AT_LEAST_32_BYTES',
      }),
    ).toThrow('JWT_SECRET');
  });
});
