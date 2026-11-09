import { once } from 'node:events';
import { createServer } from 'node:net';

import type {
  ExecutionContext,
  NestInterceptor,
  CallHandler,
  INestMicroservice,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { TcpContext } from '@nestjs/microservices';
import { tap } from 'rxjs';
import { DataSource, In } from 'typeorm';

import { AppModule } from '../src/app.module';
import { AttendanceAppModule } from '../src/attendance-app.module';
import { Clock } from '../src/runtime/clock';
import { configureHttp } from '../src/http/configure-http';
import { loadRuntimeConfig } from '../src/runtime/runtime.config';
import { RPC_CONFIG, parseRpcConfig } from '../src/attendance-rpc/rpc.config';
import { attendanceTcpOptions } from '../src/attendance-rpc/rpc.transport';
import { ATTENDANCE_PATTERNS as patterns } from '../src/attendance-rpc/rpc.contract';
import { AccessTokenService } from '../src/auth/access-token.service';
import {
  AttendanceEntity,
  ScheduleVersionEntity,
  ScheduleEventEntity,
  IdempotencyOperationEntity,
  FileObjectEntity,
  EmployeeEntity,
  PositionEntity,
  DivisionEntity,
  CalendarStateEntity,
} from '../src/database/entities';

import { insertFixture, prepareTestDatabase } from './mysql-fixture';

export class ScheduleClock extends Clock {
  value = new Date('2026-11-09T01:00:00.123Z');

  now() {
    return new Date(this.value);
  }
}

class DropCommittedReply implements NestInterceptor {
  dropNext = false;
  pattern: string = patterns.scheduleChange;

  intercept(context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      tap(() => {
        const tcp = context.switchToRpc().getContext<TcpContext>();

        if (this.dropNext && tcp.getPattern() === this.pattern) {
          this.dropNext = false;
          tcp.getSocketRef().netSocket.destroy();
        }
      }),
    );
  }
}

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));

  return port;
}

export async function scheduleApps() {
  const source = await prepareTestDatabase();

  if (await source.manager.count(ScheduleEventEntity)) {
    await source.destroy();
    throw new Error(
      'Schedule integration requires an empty schedule history in its dedicated _test database.',
    );
  }

  const config = parseRpcConfig({
    ATTENDANCE_RPC_CREDENTIAL:
      'schedule-test-only-credential-at-least-32-bytes',
    ATTENDANCE_RPC_PORT: String(await freePort()),
    ATTENDANCE_RPC_DEADLINE_MS: '2000',
  });
  const clock = new ScheduleClock();
  const replies = new DropCommittedReply();
  let attendance: INestMicroservice;

  const startAttendance = async () => {
    const module = await Test.createTestingModule({
      imports: [AttendanceAppModule],
    })
      .overrideProvider(RPC_CONFIG)
      .useValue(config)
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    attendance = module.createNestMicroservice({
      ...attendanceTcpOptions(config),
      logger: false,
    });
    attendance.useGlobalInterceptors(replies);
    await attendance.listen();

    return attendance;
  };

  await startAttendance();
  const gatewayModule = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RPC_CONFIG)
    .useValue(config)
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  const gateway = gatewayModule.createNestApplication<NestExpressApplication>({
    logger: false,
  });
  configureHttp(gateway, loadRuntimeConfig());
  await gateway.init();

  return {
    source,
    config,
    clock,
    replies,
    gateway,
    get attendance() {
      return attendance;
    },
    startAttendance,

    async token(id: string, role: 'EMPLOYEE' | 'HRD' = 'HRD') {
      return (await gateway.get(AccessTokenService).issue({ id, role }))
        .accessToken;
    },

    async close() {
      await gateway.close();
      await attendance.close();
      await source.destroy();
    },
  };
}

export async function scheduleAccounts(source: DataSource) {
  const ids = await source.transaction(insertFixture);
  await source.manager.delete(ScheduleVersionEntity, { id: ids.schedule });
  await source.manager.update(CalendarStateEntity, { id: 1 }, { version: 0 });

  return ids;
}

export async function cleanupSchedules(
  source: DataSource,
  ids: Awaited<ReturnType<typeof insertFixture>>,
) {
  const actors = In([ids.employee, ids.otherEmployee]);
  await source.manager.delete(IdempotencyOperationEntity, { actorId: actors });
  await source.manager.delete(AttendanceEntity, { employeeId: actors });
  // Test-only reset: append-only triggers forbid business DELETE/UPDATE. No production DB is used.
  await source.query('TRUNCATE TABLE schedule_events');
  await source.manager.delete(ScheduleVersionEntity, { createdBy: actors });
  await source.manager.delete(FileObjectEntity, { id: ids.file });
  await source.manager.delete(EmployeeEntity, { id: actors });
  await source.manager.delete(PositionEntity, { id: ids.position });
  await source.manager.delete(DivisionEntity, { id: ids.division });
  await source.manager.update(CalendarStateEntity, { id: 1 }, { version: 0 });
}
