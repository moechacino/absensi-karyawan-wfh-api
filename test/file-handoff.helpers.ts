import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { StagedCheckInImage } from '../src/attendance-rpc/rpc.files';

const queries = new WeakMap<
  ChildProcess,
  {
    attendanceReads: number;
    fileReads: number;
    reads: number;
    credentialReads: number;
  }
>();

export function queryCounts(child: ChildProcess): {
  attendanceReads: number;
  fileReads: number;
  reads: number;
  credentialReads: number;
} {
  return { ...queries.get(child)! };
}

export interface WrittenImage {
  event: 'written';
  image: StagedCheckInImage;
  receivedAt: string;
  pid: number;
}

export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  return port;
}

export function processMessage<T>(
  child: ChildProcess,
  event: string,
  matches: (value: T) => boolean = () => true,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for ${event}`)),
      15000,
    );
    const message = (value: unknown) => {
      if (
        value &&
        typeof value === 'object' &&
        'event' in value &&
        value.event === event &&
        matches(value as T)
      ) {
        finish(undefined, value as T);
      }
    };
    const exited = () => finish(new Error('Test child exited unexpectedly'));
    const finish = (error?: Error, value?: T) => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exited);

      if (error) {
        reject(error);
      } else {
        resolve(value!);
      }
    };
    child.on('message', message);
    child.once('exit', exited);
  });
}

export async function startProcess(
  mode: string,
  env: NodeJS.ProcessEnv,
  script = 'test/file-handoff.process.ts',
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', script],
    {
      env: { ...process.env, ...env, HANDOFF_PROCESS: mode },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  const counts = {
    attendanceReads: 0,
    fileReads: 0,
    reads: 0,
    credentialReads: 0,
  };
  queries.set(child, counts);
  child.on('message', (value: unknown) => {
    if (
      value &&
      typeof value === 'object' &&
      'event' in value &&
      value.event === 'query'
    ) {
      counts.reads++;

      if ('credentialRead' in value && value.credentialRead) {
        counts.credentialReads++;
      }
      if ('attendanceRead' in value && value.attendanceRead) {
        counts.attendanceReads++;
      }

      if ('fileRead' in value && value.fileRead) {
        counts.fileReads++;
      }
    }
  });
  let failed = false;
  child.stderr?.on('data', () => {
    failed = true;
  });

  try {
    await processMessage(child, 'ready');
  } catch {
    await stopProcess(child);
    throw new Error(
      `File handoff ${mode} process failed to start${failed ? ' (stderr received)' : ''}`,
    );
  }

  return child;
}

export async function stopProcess(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);

  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
