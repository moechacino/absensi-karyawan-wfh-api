import { DivisionEntity, PositionEntity } from './organization.entities';
import { EmployeeEntity } from './accounts.entities';
import { FileObjectEntity } from './files.entities';
import {
  CalendarStateEntity,
  ScheduleVersionEntity,
  ScheduleEventEntity,
  HolidayCalendarEntity,
  HolidayEntity,
} from './calendar.entities';
import { IdempotencyOperationEntity } from './reliability.entities';
import { AttendanceEntity } from './attendance.entities';

export {
  DivisionEntity,
  PositionEntity,
  EmployeeEntity,
  FileObjectEntity,
  CalendarStateEntity,
  ScheduleVersionEntity,
  ScheduleEventEntity,
  HolidayCalendarEntity,
  HolidayEntity,
  AttendanceEntity,
  IdempotencyOperationEntity,
};

export const DATABASE_ENTITIES = [
  DivisionEntity,
  PositionEntity,
  EmployeeEntity,
  FileObjectEntity,
  CalendarStateEntity,
  ScheduleVersionEntity,
  ScheduleEventEntity,
  HolidayCalendarEntity,
  HolidayEntity,
  AttendanceEntity,
  IdempotencyOperationEntity,
];
