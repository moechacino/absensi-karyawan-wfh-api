import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RuntimeModule } from '../runtime/runtime.module';

import { CalendarRepository } from './calendar.repository';
import { CalendarService } from './calendar.service';

@Module({
  imports: [RuntimeModule, DatabaseModule],
  providers: [CalendarRepository, CalendarService],
  exports: [CalendarService, CalendarRepository],
})
export class WorkCalendarModule {}
