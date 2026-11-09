import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { ScheduleProposal } from '../work-calendar/calendar.types';
import { ScheduleVersionEntity } from '../database/entities';
import { Clock } from '../runtime/clock';
import { CalendarService } from '../work-calendar/calendar.service';
import { scheduleDefinition } from '../work-calendar/schedule.rules';
import { timelineAt } from '../work-calendar/schedule.timeline';
import { ProblemException } from '../http/problem';
import type { PageInput } from '../attendance-rpc/rpc.inputs';
import type {
  ScheduleChanged,
  SchedulePreview,
  WorkSchedule,
  ScheduleHistoryPage,
} from '../attendance-rpc/rpc.responses';

import { ScheduleRepository } from './schedule.repository';
import {
  savedSchedule,
  scheduleVersion,
  scheduleView,
} from './schedule.mapper';

@Injectable()
export class ScheduleService {
  constructor(
    private readonly repository: ScheduleRepository,
    private readonly calendar: CalendarService,
    private readonly clock: Clock,
  ) {}

  get(): Promise<WorkSchedule> {
    return this.repository.readConsistent(async (manager) => {
      const [state, rows] = await Promise.all([
        this.repository.state(manager),
        this.repository.versions(manager),
      ]);

      return scheduleView(state.version, rows, this.clock.now());
    });
  }

  async preview(input: ScheduleProposal): Promise<SchedulePreview> {
    const activation = this.calendar.preview(input);
    const definition = scheduleDefinition(input);

    const state = await this.repository.currentState();
    const stale = input.expectedVersion !== state.version;

    return {
      schedule: {
        ...definition,
        workingDays: [...definition.workingDays].sort((a, b) => a - b),
        expectedVersion: input.expectedVersion,
        effectiveFrom: input.effectiveFrom,
      },
      ...activation,
      impact: {
        canApply: !stale,
        issues: stale
          ? [
              {
                code: 'VERSION_CONFLICT',
                field: 'expectedVersion',
                message: 'Reload the current work schedule before saving.',
              },
            ]
          : [],
      },
    };
  }

  history(input: PageInput): Promise<ScheduleHistoryPage> {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;

    return this.repository.readConsistent(async (manager) => {
      const [rows, [items, totalItems]] = await Promise.all([
        this.repository.versions(manager),
        this.repository.history(page, pageSize, manager),
      ]);
      const state = timelineAt(rows.map(savedSchedule), this.clock.now());

      return {
        items: items.map((row) =>
          scheduleVersion(row, state.current?.id, state.upcoming?.id),
        ),
        pagination: {
          page,
          pageSize,
          totalItems,
          totalPages: Math.ceil(totalItems / pageSize),
        },
      };
    });
  }

  async change(
    input: ScheduleProposal,
    actorId: string,
    manager: EntityManager,
  ): Promise<ScheduleChanged> {
    const state = await this.repository.state(manager, true);
    const at = this.clock.now();

    if (state.version !== input.expectedVersion) {
      throw new ProblemException(409, 'VERSION_CONFLICT', 'Version conflict', {
        details: {
          expectedVersion: input.expectedVersion,
          actualVersion: state.version,
        },
      });
    }

    const rows = await this.repository.versions(manager);
    const plan = this.calendar.planSave(input, rows.map(savedSchedule), at);
    const definition = scheduleDefinition(input);
    const id = randomUUID();
    const replaced = [
      ...plan.replacePendingIds,
      ...(plan.closeCurrentId ? [plan.closeCurrentId] : []),
    ];
    const nextVersion = state.version + 1;

    await this.repository.insert(
      {
        id,
        ...definition,
        workingDays: [...definition.workingDays].sort((a, b) => a - b),
        createdAt: new Date(plan.saveAt),
        createdBy: actorId,
        effectiveFrom: input.effectiveFrom,
        effectiveAt: new Date(plan.activateAt),
        supersededAt: null,
      },
      manager,
    );
    await this.repository.supersede(replaced, new Date(plan.saveAt), manager);
    await this.repository.advanceVersion(nextVersion, manager);
    const [, inserted] = await Promise.all([
      this.repository.appendEvents(
        [
          {
            id: randomUUID(),
            scheduleVersionId: id,
            actorId,
            kind: 'SAVED',
            calendarVersion: nextVersion,
            createdAt: new Date(plan.saveAt),
            details: {
              activationMode: plan.activationMode,
              effectiveFrom: input.effectiveFrom,
              effectiveAt: plan.activateAt,
            },
          },
          ...replaced.map((scheduleVersionId) => ({
            id: randomUUID(),
            scheduleVersionId,
            actorId,
            kind: 'SUPERSEDED' as const,
            calendarVersion: nextVersion,
            createdAt: new Date(plan.saveAt),
            details: { replacementVersionId: id },
          })),
        ],
        manager,
      ),
      this.repository.version(id, manager),
    ]);
    const updated = rows.map((row) =>
      replaced.includes(row.id)
        ? Object.assign(new ScheduleVersionEntity(), row, {
            supersededAt: new Date(plan.saveAt),
          })
        : row,
    );

    return { schedule: scheduleView(nextVersion, [...updated, inserted], at) };
  }
}
