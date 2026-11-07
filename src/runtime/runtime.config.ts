import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { RuntimeConfigurationError } from './runtime.errors';

export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');
const applicationRoot = resolve(__dirname, '../..');
type Environment = Readonly<Record<string, string | undefined>>;

export interface RuntimeConfig {
  readonly app: Readonly<{
    environment: 'development' | 'test' | 'production';
    host: string;
    port: number;
  }>;
  readonly database: Readonly<{
    host: string;
    port: number;
    name: string;
    username: string;
    password: string;
    poolSize: number;
    connectTimeoutMs: number;
  }>;
  readonly jwt: Readonly<{
    algorithm: 'HS256';
    secret: string;
    issuer: string;
    audience: string;
    accessTtlSeconds: number;
  }>;
  readonly browser: Readonly<{
    corsOrigins: readonly string[];
    csrfTrustedOrigins: readonly string[];
  }>;
  readonly storage: Readonly<{
    root: string;
    maxFileBytes: number;
    maxConcurrentUploads: number;
  }>;
  readonly policy: Readonly<{
    passwordMinLength: 15;
    passwordMaxLength: 128;
    businessTokenTtlSeconds: number;
    idempotencyRetentionSeconds: number;
  }>;
}

export function parseRuntimeConfig(
  env: Environment,
  baseDirectory = applicationRoot,
): RuntimeConfig {
  const issues: string[] = [];
  const text = (key: string, fallback?: string): string => {
    const value = env[key]?.trim() || fallback;
    if (!value) issues.push(`${key} is required`);
    return value ?? '';
  };
  const integer = (
    key: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number => {
    const value = env[key] ?? String(fallback);
    const parsed = Number(value);
    if (
      !/^(0|[1-9]\d*)$/.test(value) ||
      !Number.isSafeInteger(parsed) ||
      parsed < minimum ||
      parsed > maximum
    ) {
      issues.push(
        `${key} must be an integer between ${minimum} and ${maximum}`,
      );
    }
    return parsed;
  };
  const secret = (key: string, minimumBytes: number): string => {
    const value = env[key] ?? '';
    if (
      Buffer.byteLength(value) < minimumBytes ||
      /^(replace|change_me|<)/i.test(value)
    ) {
      issues.push(
        `${key} requires a non-placeholder secret of at least ${minimumBytes} bytes`,
      );
    }
    return value;
  };
  const origins = (key: string): readonly string[] => {
    if (!env[key]) return Object.freeze([]);
    const result: string[] = [];
    for (const value of env[key].split(',')) {
      const candidate = value.trim();
      try {
        const url = new URL(candidate);
        if (
          !/^https?:\/\/[^/?#]+$/.test(candidate) ||
          candidate.includes('@') ||
          url.hostname.includes('*') ||
          url.pathname !== '/' ||
          url.username ||
          url.password
        )
          throw new Error();
        if (env.NODE_ENV === 'production' && url.protocol !== 'https:')
          throw new Error();
        result.push(url.origin);
      } catch {
        issues.push(
          `${key} requires explicit HTTP(S) origins without credentials, paths or wildcards (HTTPS in production)`,
        );
      }
    }
    return Object.freeze([...new Set(result)]);
  };

  const environment = text('NODE_ENV', 'development');
  if (!['development', 'test', 'production'].includes(environment))
    issues.push('NODE_ENV must be development, test or production');
  const host = text('HOST', '127.0.0.1');
  if (!isIP(host) && host !== 'localhost')
    issues.push('HOST must be a bind IP or localhost');
  const databaseName = text('DB_NAME');
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(databaseName))
    issues.push('DB_NAME must contain 1–64 letters, digits or underscores');
  const algorithm = text('JWT_ALGORITHM', 'HS256');
  if (algorithm !== 'HS256')
    issues.push('JWT_ALGORITHM must be HS256 for this runtime baseline');
  const storageValue = text('STORAGE_ROOT');
  const storageRoot = resolve(baseDirectory, storageValue);
  const storageRelative = relative(baseDirectory, storageRoot);
  if (
    !isAbsolute(storageRelative) &&
    storageRelative !== '..' &&
    !storageRelative.startsWith(`..${sep}`)
  ) {
    issues.push('STORAGE_ROOT must be outside the application directory');
  }

  const config: RuntimeConfig = {
    app: Object.freeze({
      environment: environment as RuntimeConfig['app']['environment'],
      host,
      port: integer('PORT', 3000, 1, 65535),
    }),
    database: Object.freeze({
      host: text('DB_HOST'),
      port: integer('DB_PORT', 3306, 1, 65535),
      name: databaseName,
      username: text('DB_USERNAME'),
      password: secret('DB_PASSWORD', 1),
      poolSize: integer('DB_POOL_SIZE', 10, 1, 100),
      connectTimeoutMs: integer('DB_CONNECT_TIMEOUT_MS', 10000, 100, 60000),
    }),
    jwt: Object.freeze({
      algorithm: 'HS256',
      secret: secret('JWT_SECRET', 32),
      issuer: text('JWT_ISSUER'),
      audience: text('JWT_AUDIENCE'),
      accessTtlSeconds: integer('JWT_ACCESS_TTL_SECONDS', 28800, 300, 86400),
    }),
    browser: Object.freeze({
      corsOrigins: origins('CORS_ORIGINS'),
      csrfTrustedOrigins: origins('CSRF_TRUSTED_ORIGINS'),
    }),
    storage: Object.freeze({
      root: storageRoot,
      maxFileBytes: integer('MAX_FILE_BYTES', 5242880, 1, 5242880),
      maxConcurrentUploads: integer('MAX_CONCURRENT_UPLOADS', 4, 1, 32),
    }),
    policy: Object.freeze({
      passwordMinLength: 15,
      passwordMaxLength: 128,
      businessTokenTtlSeconds: integer(
        'BUSINESS_TOKEN_TTL_SECONDS',
        600,
        1,
        600,
      ),
      idempotencyRetentionSeconds: integer(
        'IDEMPOTENCY_RETENTION_SECONDS',
        86400,
        86400,
        31536000,
      ),
    }),
  };
  if (issues.length) throw new RuntimeConfigurationError(issues);
  return Object.freeze(config);
}

export function loadRuntimeConfig(): RuntimeConfig {
  const filename = resolve(applicationRoot, '.env');
  let fileEnvironment: Environment = {};
  if (process.env.NODE_ENV !== 'test' && existsSync(filename)) {
    try {
      fileEnvironment = parseEnv(readFileSync(filename, 'utf8'));
    } catch {
      throw new RuntimeConfigurationError(['.env could not be read']);
    }
  }
  // Explicit process variables win. Tests never implicitly load developer secrets.
  return parseRuntimeConfig({ ...fileEnvironment, ...process.env });
}
