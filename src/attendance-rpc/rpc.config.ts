import { RuntimeConfigurationError } from '../runtime/runtime.errors';
import { loadRuntimeEnvironment } from '../runtime/runtime.config';

export const RPC_CONFIG = Symbol('RPC_CONFIG');
export const RPC_REQUEST_BYTES = 256 * 1024;
export const RPC_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface RpcConfig {
  readonly host: '127.0.0.1' | '::1';
  readonly port: number;
  readonly serviceCredential: string;
  readonly deadlineMs: number;
}

export function parseRpcConfig(
  env: Readonly<Record<string, string | undefined>>,
): RpcConfig {
  const issues: string[] = [];
  const host = env.ATTENDANCE_RPC_HOST ?? '127.0.0.1';

  if (host !== '127.0.0.1' && host !== '::1') {
    issues.push('ATTENDANCE_RPC_HOST must be a loopback IP (127.0.0.1 or ::1)');
  }

  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key] ?? String(fallback);
    const value = Number(raw);

    if (
      !/^[1-9]\d*$/.test(raw) ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    ) {
      issues.push(`${key} must be an integer between ${min} and ${max}`);
    }

    return value;
  };

  const port = integer('ATTENDANCE_RPC_PORT', 4001, 1, 65535);
  const deadlineMs = integer('ATTENDANCE_RPC_DEADLINE_MS', 5000, 100, 60000);
  const serviceCredential = env.ATTENDANCE_RPC_CREDENTIAL ?? '';

  if (
    Buffer.byteLength(serviceCredential) < 32 ||
    Buffer.byteLength(serviceCredential) > 256 ||
    /^(replace|change_me|<)/i.test(serviceCredential)
  ) {
    issues.push(
      'ATTENDANCE_RPC_CREDENTIAL requires a non-placeholder secret of 32–256 bytes',
    );
  }

  if (serviceCredential && serviceCredential === env.JWT_SECRET) {
    issues.push('ATTENDANCE_RPC_CREDENTIAL must differ from JWT_SECRET');
  }

  if (issues.length) {
    throw new RuntimeConfigurationError(issues);
  }

  return Object.freeze({
    host: host as RpcConfig['host'],
    port,
    deadlineMs,
    serviceCredential,
  });
}

export function loadRpcConfig(): RpcConfig {
  return parseRpcConfig(loadRuntimeEnvironment());
}
