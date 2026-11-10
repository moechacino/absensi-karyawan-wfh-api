import { Injectable } from '@nestjs/common';
import type {
  Attendance,
  AttendanceDayPage,
  MonitoringPage,
} from '../attendance-rpc/rpc.responses';
import type {
  AttendanceDaysInput,
  MonitoringInput,
} from '../attendance-rpc/rpc.inputs';
import { CalendarRepository } from '../work-calendar/calendar.repository';
import { Clock } from '../runtime/clock';
import { ProblemException } from '../http/problem';
import { isOpenShift } from '../attendance/attendance.rules';
import {
  checkoutDeadline,
  checkoutDeadlines,
} from '../attendance/checkout.rules';
import { attendanceView } from '../attendance/attendance.mapper';
import { AttendanceReadRepository } from './attendance-read.repository';
import { MonitoringRepository } from './monitoring.repository';
import {
  datedContext,
  existedOnDate,
  historyDates,
  monitoringTotals,
  pagination,
  projectedDay,
} from './attendance-read.rules';
import { monitoringEmployee } from './monitoring.mapper';

@Injectable()
export class AttendanceReadService {
  constructor(
    private readonly repository: AttendanceReadRepository,
    private readonly monitoring: MonitoringRepository,
    private readonly calendar: CalendarRepository,
    private readonly clock: Clock,
  ) {}

  async history(
    employeeId: string,
    input: AttendanceDaysInput,
  ): Promise<AttendanceDayPage> {
    const dates = historyDates(input.from, input.to);
    const at = this.clock.now();
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;

    return this.repository.consistent(async (manager) => {
      const [employee, versions, records] = await Promise.all([
        this.repository.employee(employeeId, manager),
        this.calendar.timeline(manager),
        this.repository.history(employeeId, input.from, input.to, manager),
      ]);

      if (!employee) {
        throw new ProblemException(404, 'NOT_FOUND', 'Resource not found');
      }

      const from = [
        input.from,
        ...records.map((row) => row.workDate),
      ].toSorted()[0];
      const holidays = await this.repository.holidays(from, manager);
      const holidayDatesArray = holidays.map((row) => row.date);
      const deadlines = checkoutDeadlines(records, versions, holidayDatesArray);
      const actual = new Map(records.map((row) => [row.workDate, row]));
      const holidayDates = new Set(holidays.map((row) => row.date));
      const contexts = dates.map((date) =>
        datedContext(date, versions, holidayDates.has(date)),
      );
      const visible = contexts.filter(
        (context) =>
          actual.has(context.date) ||
          existedOnDate(employee.createdAt, context),
      );
      const hasOpen = records.some((row) =>
        isOpenShift(row, at, deadlines.get(row.id)),
      );
      const items = visible
        .slice((page - 1) * pageSize, page * pageSize)
        .map((context) => {
          const row = actual.get(context.date);

          return projectedDay(
            context,
            at,
            row
              ? attendanceView(row, row.photo, at, deadlines.get(row.id))
              : null,
            hasOpen,
          );
        });

      return { items, pagination: pagination(page, pageSize, visible.length) };
    });
  }

  async detail(id: string, employeeId?: string): Promise<Attendance> {
    const at = this.clock.now();

    return this.repository.consistent(async (manager) => {
      const [row, versions] = await Promise.all([
        this.repository.detail(id, employeeId, manager),
        this.calendar.timeline(manager),
      ]);
      if (!row)
        throw new ProblemException(404, 'NOT_FOUND', 'Resource not found');
      const holidays = await this.repository.holidays(row.workDate, manager);
      const deadline = checkoutDeadline(
        versions,
        row.workDate,
        holidays.map((holiday) => holiday.date),
      );

      return attendanceView(row, row.photo, at, deadline);
    });
  }

  monitor(input: MonitoringInput): Promise<MonitoringPage> {
    const at = this.clock.now();
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;

    return this.repository.consistent(async (manager) => {
      const [versions, pending] = await Promise.all([
        this.calendar.timeline(manager),
        this.repository.pending(manager),
      ]);
      const from = [
        input.date,
        ...pending.map((row) => row.workDate),
      ].toSorted()[0];
      const holidays = await this.repository.holidays(from, manager);
      const holidayDates = holidays.map((row) => row.date);
      const deadlines = checkoutDeadlines(pending, versions, holidayDates);
      const expiredIds = pending
        .filter(
          (row) =>
            row.workDate === input.date &&
            !isOpenShift(row, at, deadlines.get(row.id)),
        )
        .map((row) => row.id);
      const context = datedContext(
        input.date,
        versions,
        holidayDates.includes(input.date),
      );
      const selected = await this.monitoring.selected(
        input,
        context,
        manager,
        expiredIds,
      );
      const { totalItems, summary } = monitoringTotals(selected.totals);
      const [employees, records] = await Promise.all([
        this.monitoring.employees(selected.ids, manager),
        this.repository.selectedRecords(selected.ids, input.date, manager),
      ]);
      const selectedDeadlines = checkoutDeadlines(
        records,
        versions,
        holidayDates,
      );
      const byId = new Map(employees.map((row) => [row.id, row]));
      const actual = new Map(
        records
          .filter((row) => row.workDate === input.date)
          .map((row) => [row.employeeId, row]),
      );
      const open = new Set(
        records
          .filter((row) => isOpenShift(row, at, selectedDeadlines.get(row.id)))
          .map((row) => row.employeeId),
      );
      const items = selected.ids.map((id) => {
        const row = actual.get(id);

        return {
          employee: monitoringEmployee(byId.get(id)!),
          day: projectedDay(
            context,
            at,
            row
              ? attendanceView(
                  row,
                  row.photo,
                  at,
                  selectedDeadlines.get(row.id),
                )
              : null,
            open.has(id),
          ),
        };
      });

      return {
        items,
        pagination: pagination(page, pageSize, totalItems),
        summary,
      };
    });
  }
}
