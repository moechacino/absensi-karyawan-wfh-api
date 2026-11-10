import 'reflect-metadata';
import { Injectable, Global, Module } from '@nestjs/common';
import type {
  INestMicroservice,
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { TcpContext } from '@nestjs/microservices';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { tap, delay } from 'rxjs';
import { MonitoringRepository } from '../src/attendance-reads/monitoring.repository';
import type { MonitoringInput } from '../src/attendance-rpc/rpc.inputs';
import type { DatedContext } from '../src/attendance-reads/attendance-read.rules';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AttendanceAppModule } from '../src/attendance-app.module';
import { AttendanceRepository } from '../src/attendance/attendance.repository';
import type { AttendanceEntity } from '../src/database/entities';
import { Clock } from '../src/runtime/clock';
import { loadRuntimeConfig } from '../src/runtime/runtime.config';
import { loadRpcConfig } from '../src/attendance-rpc/rpc.config';
import { attendanceTcpOptions } from '../src/attendance-rpc/rpc.transport';
import { configureHttp } from '../src/http/configure-http';

class TestClock extends Clock {
  value = new Date('2026-11-09T01:00:00.001Z');

  now(): Date {
    return new Date(this.value);
  }
}

@Injectable()
class ProbeState {
  hold = false;
  dropReply = false;
  readDelayMs = 0;
  holdRead = false;
  releaseRead?: () => void;
  release?: () => void;
}

@Global()
@Module({ providers: [ProbeState], exports: [ProbeState] })
class TestControlModule {}

// SQL and business handlers remain production code; tests can pause an uncommitted insert.
@Injectable()
class PausedRepository extends AttendanceRepository {
  constructor(
    source: DataSource,
    private readonly state: ProbeState,
  ) {
    super(source);
  }

  override async lockEmployee(
    id: string,
    manager: EntityManager,
  ): Promise<void> {
    process.send?.({ event: 'employee-lock-requested', employeeId: id });
    await super.lockEmployee(id, manager);
  }

  override async insert(
    row: AttendanceEntity,
    manager: EntityManager,
  ): Promise<void> {
    await super.insert(row, manager);
    const gate = this.state.hold
      ? new Promise<void>((resolve) => {
          this.state.release = resolve;
        })
      : Promise.resolve();
    process.send?.({
      event: 'attendance-written',
      employeeId: row.employeeId,
      id: row.id,
      fileId: row.photoFileId,
      checkInAt: row.checkInAt.toISOString(),
    });
    await gate;
  }
}

@Injectable()
class PausedMonitoringRepository extends MonitoringRepository {
  constructor(private readonly state: ProbeState) {
    super();
  }

  override async selected(
    input: MonitoringInput,
    context: DatedContext,
    manager: EntityManager,
    expiredIds: string[],
  ) {
    const result = await super.selected(input, context, manager, expiredIds);

    if (this.state.holdRead) {
      const gate = new Promise<void>((resolve) => {
        this.state.releaseRead = resolve;
      });
      process.send?.({ event: 'monitoring-selected' });
      await gate;
    }

    return result;
  }
}

@Injectable()
class LoseReplyInterceptor implements NestInterceptor {
  constructor(private readonly state: ProbeState) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const write = context
      .switchToRpc()
      .getData<{ idempotencyKey?: string }>().idempotencyKey;

    return next.handle().pipe(
      delay(write ? 0 : this.state.readDelayMs),
      tap((result: unknown) => {
        if (
          this.state.dropReply &&
          result &&
          typeof result === 'object' &&
          'replayed' in result
        ) {
          this.state.dropReply = false;
          context
            .switchToRpc()
            .getContext<TcpContext>()
            .getSocketRef()
            .netSocket.destroy();
        }
      }),
    );
  }
}

async function main(): Promise<void> {
  if (
    process.env.NODE_ENV !== 'test' ||
    !process.env.DB_NAME?.endsWith('_test')
  ) {
    throw new Error('Disposable test environment required');
  }

  const attendance = process.env.HANDOFF_PROCESS === 'attendance';
  const clock = new TestClock();
  const builder = Test.createTestingModule({
    imports: [TestControlModule, attendance ? AttendanceAppModule : AppModule],
    providers: attendance
      ? [{ provide: APP_INTERCEPTOR, useClass: LoseReplyInterceptor }]
      : [],
  })
    .overrideProvider(Clock)
    .useValue(clock);

  if (attendance) {
    builder.overrideProvider(AttendanceRepository).useClass(PausedRepository);
    builder
      .overrideProvider(MonitoringRepository)
      .useClass(PausedMonitoringRepository);
  }

  const module = await builder.compile();
  const app = attendance
    ? module.createNestMicroservice({
        ...attendanceTcpOptions(loadRpcConfig()),
        logger: false,
      })
    : module.createNestApplication<NestExpressApplication>({ logger: false });
  const source = app.get(DataSource);
  source.logger.logQuery = (query: string) => {
    if (/^SELECT\b/i.test(query)) {
      process.send?.({
        event: 'query',
        attendanceRead: /\battendances\b/.test(query),
        fileRead: /\bfile_objects\b/.test(query),
        credentialRead:
          /initial_password|password_hash|has_password_changed|\bemail\b/i.test(
            query,
          ),
      });
    }
  };
  app.enableShutdownHooks();

  if (attendance) {
    await (app as INestMicroservice).listen();
  } else {
    const http = app as NestExpressApplication;
    configureHttp(http, loadRuntimeConfig());
    await http.listen(Number(process.env.PORT), '127.0.0.1');
  }

  process.on(
    'message',
    (message: {
      event?: string;
      at?: string;
      hold?: boolean;
      dropReply?: boolean;
      readDelayMs?: number;
      holdRead?: boolean;
      id?: string;
    }) => {
      if (message.event !== 'control') {
        return;
      }

      if (message.at) {
        clock.value = new Date(message.at);
      }

      if (attendance) {
        const state = module.get(ProbeState);

        if (message.hold !== undefined) {
          state.hold = message.hold;

          if (!state.hold) {
            state.release?.();
            state.release = undefined;
          }
        }

        if (message.readDelayMs !== undefined) {
          state.readDelayMs = message.readDelayMs;
        }

        if (message.holdRead !== undefined) {
          state.holdRead = message.holdRead;

          if (!state.holdRead) {
            state.releaseRead?.();
            state.releaseRead = undefined;
          }
        }

        if (message.dropReply !== undefined) {
          state.dropReply = message.dropReply;
        }
      }

      process.send?.({ event: 'controlled', id: message.id });
    },
  );
  process.send?.({ event: 'ready', pid: process.pid });
}

void main().catch(() => {
  console.error('Attendance feature test process failed to start.');
  process.exitCode = 1;
});
