import { Transform } from 'class-transformer';
import {
  AttendanceDaysInput,
  MonitoringInput,
} from '../attendance-rpc/rpc.inputs';
import { queryInteger } from '../http/parsing';

export class AttendanceHistoryQuery extends AttendanceDaysInput {
  @Transform(({ value }) => queryInteger(value, 'page'))
  override page = 1;

  @Transform(({ value }) => queryInteger(value, 'pageSize'))
  override pageSize = 20;
}

export class AttendanceMonitoringQuery extends MonitoringInput {
  @Transform(({ value }) => queryInteger(value, 'page'))
  override page = 1;

  @Transform(({ value }) => queryInteger(value, 'pageSize'))
  override pageSize = 20;
}
