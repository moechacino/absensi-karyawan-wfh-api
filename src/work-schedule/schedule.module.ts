import { Module } from '@nestjs/common';

import { WorkCalendarModule } from '../work-calendar/calendar.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';

import { ScheduleRepository } from './schedule.repository';
import { ScheduleService } from './schedule.service';
import { TimeZonesService } from './time-zones.service';
import { ScheduleRpcController } from './schedule.rpc-controller';

@Module({
  imports: [WorkCalendarModule, IdempotencyModule],
  controllers: [ScheduleRpcController],
  exports: [ScheduleRepository],
  providers: [ScheduleRepository, ScheduleService, TimeZonesService],
})
export class ScheduleModule {}
