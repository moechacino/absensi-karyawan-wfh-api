import { Module } from '@nestjs/common';

import { WorkCalendarModule } from '../work-calendar/calendar.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';

import { HolidayRepository } from './holiday.repository';
import { HolidayService } from './holiday.service';
import { HolidayRpcController } from './holiday.rpc-controller';

@Module({
  imports: [WorkCalendarModule, IdempotencyModule],
  controllers: [HolidayRpcController],
  providers: [HolidayRepository, HolidayService],
})
export class HolidayModule {}
