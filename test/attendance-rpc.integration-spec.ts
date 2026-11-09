import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection, createServer } from 'node:net';

import type { INestMicroservice } from '@nestjs/common';
import { Controller, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  ClientProxyFactory,
  Transport,
  Ctx,
  MessagePattern,
  Payload,
} from '@nestjs/microservices';
import type { ClientProxy, TcpContext } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { DataSource } from 'typeorm';

import { AttendanceAppModule } from '../src/attendance-app.module';
import { AccessTokenService } from '../src/auth/access-token.service';
import { ATTENDANCE_PATTERNS as patterns } from '../src/attendance-rpc/rpc.contract';
import {
  RPC_REQUEST_BYTES,
  RPC_RESPONSE_BYTES,
} from '../src/attendance-rpc/rpc.config';
import {
  TimeZonesInput,
  ScheduleInput,
} from '../src/attendance-rpc/rpc.inputs';
import { rpcActor } from '../src/attendance-rpc/rpc.guard';
import { attendanceTcpOptions } from '../src/attendance-rpc/rpc.transport';

import { prepareTestDatabase } from './mysql-fixture';

let executions = 0;

// These handlers exist only in this test module, never in the production listener.
@Controller()
class ProbeController {
  @MessagePattern(patterns.timeZonesList)
  probe(
    @Payload('input') input: TimeZonesInput,
    @Payload('requestId') requestId: string,
    @Ctx() context: TcpContext,
  ) {
    executions++;

    if (input.q === 'explode') {
      throw new Error('secret-marker SQL password JWT');
    }

    if (input.q === 'large') {
      return 'x'.repeat(RPC_RESPONSE_BYTES);
    }

    return { requestId, actor: rpcActor(context), q: input.q ?? null };
  }

  @MessagePattern(patterns.scheduleChange)
  write(@Payload('input') input: ScheduleInput) {
    executions++;
    return { expectedVersion: input.expectedVersion };
  }
}

@Module({ imports: [AttendanceAppModule], controllers: [ProbeController] })
class ProbeModule {}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

  return port;
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port: number, child: ReturnType<typeof spawn>) {
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('Child exited before listen');
    }

    if (await portOpen(port)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('Child did not listen within 10 seconds');
}

async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) {
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

  expect(child.signalCode).not.toBe('SIGKILL');
  expect(child.exitCode === 0 || child.signalCode === 'SIGTERM').toBe(true);
}

describe('standalone attendance TCP foundation with MySQL', () => {
  let app: INestMicroservice;
  let client: ClientProxy;
  let employeeToken: string;
  let hrToken: string;
  let port: number;
  const actorId = randomUUID();
  const credential = 'rpc-integration-test-only-credential-32-bytes';

  const config = () => ({
    host: '127.0.0.1' as const,
    port,
    serviceCredential: credential,
    deadlineMs: 2000,
  });

  const envelope = (input: unknown = {}) => ({
    version: 1,
    requestId: randomUUID(),
    serviceCredential: credential,
    accessToken: employeeToken,
    input,
  });

  const send = (data: unknown, pattern: string = patterns.timeZonesList) =>
    firstValueFrom(client.send(pattern, data).pipe(timeout(2000)));

  beforeAll(async () => {
    const source = await prepareTestDatabase();
    await source.destroy();

    process.env.ATTENDANCE_RPC_CREDENTIAL = credential;
    port = await freePort();

    app = await NestFactory.createMicroservice(ProbeModule, {
      ...attendanceTcpOptions(config()),
      logger: false,
      abortOnError: false,
    });
    await app.listen();

    const tokens = app.get(AccessTokenService);
    employeeToken = (await tokens.issue({ id: actorId, role: 'EMPLOYEE' }))
      .accessToken;
    hrToken = (await tokens.issue({ id: randomUUID(), role: 'HRD' }))
      .accessToken;

    client = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: { host: config().host, port, maxBufferSize: RPC_RESPONSE_BYTES },
    });
  });

  afterAll(async () => {
    client?.close();
    await app?.close();
  });

  it('performs real request-response with locally verified JWT claims and correlation ID', async () => {
    const data = envelope({ q: 'Asia' });

    await expect(send(data)).resolves.toEqual({
      requestId: data.requestId,
      actor: { id: actorId, role: 'EMPLOYEE' },
      q: 'Asia',
    });
  });

  it('rejects invalid credential/JWT/version/envelope and DTOs before handler execution', async () => {
    const before = executions;

    for (const [data, code] of [
      [{ ...envelope(), serviceCredential: 'wrong' }, 'RPC_UNAUTHORIZED'],
      [{ ...envelope(), accessToken: 'invalid' }, 'TOKEN_INVALID'],
      [{ ...envelope(), version: 2 }, 'RPC_UNSUPPORTED_VERSION'],
      [{ ...envelope(), actor: { role: 'HRD' } }, 'RPC_INVALID_ENVELOPE'],
      [envelope({ q: 'a'.repeat(161) }), 'RPC_VALIDATION_FAILED'],
      [envelope({ q: null }), 'RPC_VALIDATION_FAILED'],
      [envelope({ atDate: '2026-02-30' }), 'RPC_VALIDATION_FAILED'],
      [envelope({ path: '/private/files' }), 'RPC_VALIDATION_FAILED'],
    ] as const) {
      await expect(send(data)).rejects.toMatchObject({ version: 1, code });
    }

    expect(executions).toBe(before);
  });

  it('authorizes and validates writes before any simulated receipt/handler work', async () => {
    const before = executions;
    const write = { ...envelope(), idempotencyKey: randomUUID() };

    await expect(send(write, patterns.scheduleChange)).rejects.toMatchObject({
      code: 'RPC_FORBIDDEN',
    });
    await expect(
      send({ ...write, accessToken: hrToken }, patterns.scheduleChange),
    ).rejects.toMatchObject({ code: 'RPC_VALIDATION_FAILED' });
    expect(executions).toBe(before);

    const input = {
      expectedVersion: 0,
      workingDays: [1],
      startTime: '08:00',
      endTime: '16:00',
      endDayOffset: 0,
      timeZone: 'Asia/Jakarta',
      effectiveFrom: '2026-11-10',
    };

    await expect(
      send({ ...write, accessToken: hrToken, input }, patterns.scheduleChange),
    ).resolves.toEqual({ expectedVersion: 0 });
  });

  it('sanitizes unexpected failures and bounds response size', async () => {
    await expect(send(envelope({ q: 'explode' }))).rejects.toEqual({
      version: 1,
      kind: 'internal',
      status: 500,
      code: 'RPC_INTERNAL_ERROR',
      message: 'Attendance RPC request failed.',
    });
    await expect(send(envelope({ q: 'large' }))).rejects.toMatchObject({
      code: 'RPC_RESPONSE_TOO_LARGE',
    });
  });

  it('drops an oversized frame declaration without buffering its body', async () => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.on('error', () => undefined);
    await once(socket, 'connect');

    const closed = new Promise<void>((resolve) =>
      socket.once('close', () => resolve()),
    );

    socket.write(`${RPC_REQUEST_BYTES + 1}#`);
    await closed;

    expect(socket.destroyed).toBe(true);
    await expect(send(envelope())).resolves.toMatchObject({
      actor: { id: actorId },
    });
  });

  it('fails an occupied-port startup and closes its independently owned SQL pool', async () => {
    const duplicate = await NestFactory.createMicroservice(
      AttendanceAppModule,
      { ...attendanceTcpOptions(config()), logger: false, abortOnError: false },
    );
    const pool = duplicate.get(DataSource);

    try {
      await expect(duplicate.listen()).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
    } finally {
      await duplicate.close();
    }

    expect(pool.isInitialized).toBe(false);
  });

  it('closes sockets/pool and reconnects the same client after service restart', async () => {
    const pool = app.get(DataSource);
    await app.close();

    expect(pool.isInitialized).toBe(false);
    expect(await portOpen(port)).toBe(false);
    await expect(send(envelope())).rejects.toBeDefined();

    app = await NestFactory.createMicroservice(ProbeModule, {
      ...attendanceTcpOptions(config()),
      logger: false,
      abortOnError: false,
    });
    await app.listen();

    await expect(send(envelope())).resolves.toMatchObject({
      actor: { id: actorId },
    });
  });

  it('rejects invalid startup configuration without exposing the rejected credential', () => {
    const secret = 'short-secret-marker';
    const result = spawnSync(process.execPath, ['dist/attendance-main.js'], {
      env: { ...process.env, ATTENDANCE_RPC_CREDENTIAL: secret },
      encoding: 'utf8',
      timeout: 5000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ATTENDANCE_RPC_CREDENTIAL');
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).toBe('');
  });

  it('starts both production entry points as independent processes; gateway works while TCP is absent', async () => {
    const gatewayPort = await freePort();
    const servicePort = await freePort();
    const env = {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(gatewayPort),
      ATTENDANCE_RPC_PORT: String(servicePort),
    };
    const gateway = spawn(process.execPath, ['dist/main.js'], {
      env,
      stdio: 'ignore',
    });
    let attendance: ReturnType<typeof spawn> | undefined;

    try {
      await waitForPort(gatewayPort, gateway);
      expect(await portOpen(servicePort)).toBe(false);

      const profile = () => fetch(`http://127.0.0.1:${gatewayPort}/api/v1/me`);

      expect((await profile()).status).toBe(401);

      attendance = spawn(process.execPath, ['dist/attendance-main.js'], {
        env,
        stdio: 'ignore',
      });
      await waitForPort(servicePort, attendance);
      expect((await profile()).status).toBe(401);

      await stop(attendance);
      expect(await portOpen(servicePort)).toBe(false);
      expect((await profile()).status).toBe(401);
    } finally {
      if (attendance) {
        await stop(attendance);
      }

      await stop(gateway);
    }

    expect(await portOpen(gatewayPort)).toBe(false);
  });
});
