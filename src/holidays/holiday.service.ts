import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type {
  ChangeImpact,
  HolidayCalendar,
  HolidayChanged,
} from '../attendance-rpc/rpc.responses';
import { CalendarService } from '../work-calendar/calendar.service';
import { CalendarRepository } from '../work-calendar/calendar.repository';
import { Clock } from '../runtime/clock';
import { ProblemException } from '../http/problem';

import { HolidayRepository } from './holiday.repository';
import { holidayIssues } from './holiday.rules';
import type { HolidayBatch } from './holiday.rules';

@Injectable()
export class HolidayService {
  constructor(
    private readonly repository: HolidayRepository,
    private readonly calendar: CalendarService,
    private readonly timelines: CalendarRepository,
    private readonly clock: Clock,
  ) {}

  get(year: number): Promise<HolidayCalendar> {
    return this.repository.readConsistent((manager) =>
      this.repository.calendar(year, manager),
    );
  }

  preview(input: HolidayBatch): Promise<ChangeImpact> {
    return this.repository.readConsistent(async (manager) => {
      const [calendar, versions] = await Promise.all([
        this.repository.calendar(input.year, manager),
        this.timelines.timeline(manager),
      ]);
      const cutoff = this.calendar.holidayCutoff(versions, this.clock.now());

      return holidayIssues(input, calendar.version, cutoff);
    });
  }

  async change(
    input: HolidayBatch,
    manager: EntityManager,
  ): Promise<HolidayChanged> {
    const state = await this.repository.lock(manager);
    const at = this.clock.now();
    const [calendar, versions] = await Promise.all([
      this.repository.calendar(input.year, manager),
      this.timelines.timeline(manager),
    ]);
    const cutoff = this.calendar.holidayCutoff(versions, at);
    const impact = holidayIssues(input, calendar.version, cutoff);

    if (!impact.canApply) {
      const issue = impact.issues[0];

      throw new ProblemException(
        issue.code === 'VERSION_CONFLICT' ? 409 : 422,
        issue.code,
        'Holiday batch cannot be applied',
        {
          errors: impact.issues.map(({ code, field, message }) => ({
            code,
            field: field!,
            message,
          })),
          ...(issue.code === 'VERSION_CONFLICT'
            ? {
                details: {
                  expectedVersion: input.expectedVersion,
                  actualVersion: calendar.version,
                },
              }
            : {}),
        },
      );
    }

    await this.repository.apply(
      input,
      calendar.version + 1,
      state.version + 1,
      manager,
    );

    return { calendar: await this.repository.calendar(input.year, manager) };
  }
}
