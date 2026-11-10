import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmod } from 'node:fs/promises';

export function runOperation(
  args: string[],
  input: unknown,
  env: NodeJS.ProcessEnv,
) {
  const child = spawn(process.execPath, ['dist/operations-main.js', ...args], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (bytes: Buffer) => {
    stdout += bytes.toString();
  });
  child.stderr.on('data', (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(JSON.stringify(input));
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);

  return once(child, 'close')
    .then(([code, signal]) => ({
      code: code as number | null,
      signal,
      stdout,
      stderr,
    }))
    .finally(() => clearTimeout(timer));
}

export function launchApp(
  mode: 'gateway' | 'attendance',
  env: NodeJS.ProcessEnv,
) {
  const child = spawn(
    process.execPath,
    [mode === 'gateway' ? 'dist/main.js' : 'dist/attendance-main.js'],
    {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let logs = '';
  child.stdout.on('data', (bytes: Buffer) => {
    logs += bytes.toString();
  });
  child.stderr.on('data', (bytes: Buffer) => {
    logs += bytes.toString();
  });
  const exited = once(child, 'close');
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Startup deadline exceeded'));
    }, 15000);
    const data = () => {
      if (
        logs.includes(
          mode === 'gateway' ? 'Gateway ready.' : 'Attendance ready.',
        )
      ) {
        clearTimeout(timer);
        child.stdout.off('data', data);
        resolve();
      }
    };
    child.stdout.on('data', data);
    const failed = () => {
      clearTimeout(timer);
      child.stdout.off('data', data);
      reject(new Error('Process exited before readiness'));
    };
    void exited.then(failed, failed);
  });
  // Failures are observed either through ready or exited, depending on the test.
  void ready.catch(() => undefined);

  return { child, ready, exited, logs: () => logs };
}

export async function gracefulStop(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'close');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);

  try {
    const [code, signal] = await exited;
    expect(code === 0 || signal === 'SIGTERM').toBe(true);
  } finally {
    clearTimeout(timer);
  }
}

// Only the disposable integration database is passed here. Credentials stay in env.
export async function mysqlFile(
  kind: 'dump' | 'restore',
  database: string,
  file: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!database.endsWith('_test'))
    throw new Error('Disposable database required');
  const { open } = await import('node:fs/promises');
  const handle = await open(file, kind === 'dump' ? 'w' : 'r', 0o600);
  const binary =
    kind === 'dump'
      ? (env.MYSQLDUMP_BIN ?? 'mysqldump')
      : (env.MYSQL_BIN ?? 'mysql');
  const connection = [
    '--no-defaults',
    '--protocol=TCP',
    `--host=${env.DB_HOST}`,
    `--port=${env.DB_PORT ?? '3306'}`,
    `--user=${env.DB_USERNAME}`,
  ];
  const args =
    kind === 'dump'
      ? [
          ...connection,
          '--single-transaction',
          '--routines',
          '--triggers',
          '--no-tablespaces',
          '--set-gtid-purged=OFF',
          database,
        ]
      : [...connection, database];

  try {
    const child = spawn(binary, args, {
      env: { ...process.env, MYSQL_PWD: env.DB_PASSWORD },
      stdio:
        kind === 'dump'
          ? ['ignore', handle.fd, 'pipe']
          : [handle.fd, 'ignore', 'pipe'],
    });
    child.stderr?.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);

    try {
      const [code] = await once(child, 'close');
      if (code !== 0) throw new Error(`Disposable SQL ${kind} failed`);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await handle.close();
    if (kind === 'dump') await chmod(file, 0o600);
  }
}
