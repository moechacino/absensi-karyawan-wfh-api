import type {
  StagedCheckInImage,
  FileAccessInput,
  CommandOutcomeInput,
  FileReadDescriptor,
  CommandOutcome,
} from './rpc.files';
import type * as Input from './rpc.inputs';
import type * as Response from './rpc.responses';

export const ATTENDANCE_PATTERNS = {
  scheduleGet: 'attendance.v1.schedule.get',
  timeZonesList: 'attendance.v1.time-zones.list',
  schedulePreview: 'attendance.v1.schedule.preview',
  scheduleChange: 'attendance.v1.schedule.change',
  scheduleVersions: 'attendance.v1.schedule.versions',
  holidaysGet: 'attendance.v1.holidays.get',
  holidaysPreview: 'attendance.v1.holidays.preview',
  holidaysChange: 'attendance.v1.holidays.change',
  homeGet: 'attendance.v1.home.get',
  checkIn: 'attendance.v1.check-in',
  checkOut: 'attendance.v1.check-out',
  daysList: 'attendance.v1.days.list',
  recordGet: 'attendance.v1.record.get',
  monitoringList: 'attendance.v1.monitoring.list',
  hrRecordGet: 'attendance.v1.hr-record.get',
  fileAccess: 'attendance.v1.file-access',
  commandOutcome: 'attendance.v1.command-outcome',
} as const;

export interface RpcEnvelope<TInput> {
  version: 1;
  requestId: string;
  serviceCredential: string;
  accessToken: string;
  input: TInput;
}

export interface RpcWriteEnvelope<TInput> extends RpcEnvelope<TInput> {
  idempotencyKey: string;
}

export interface RpcCommandReply<TBody> {
  status: 200 | 201;
  body: TBody;
  replayed: boolean;
}

// Transport-generated fields never belong in the logical command fingerprint.
export interface CheckInEnvelope extends RpcWriteEnvelope<Input.EmptyInput> {
  fullUploadReceivedAt: string;
  stagedImage: StagedCheckInImage;
}

export interface CheckInRpcOperation {
  request: CheckInEnvelope;
  response: RpcCommandReply<Response.Attendance>;
}

export interface AttendanceRpcOperations {
  'attendance.v1.check-in': CheckInRpcOperation;
  'attendance.v1.file-access': {
    request: RpcEnvelope<FileAccessInput>;
    response: FileReadDescriptor;
  };
  'attendance.v1.command-outcome': {
    request: RpcEnvelope<CommandOutcomeInput>;
    response: CommandOutcome;
  };
  'attendance.v1.schedule.get': {
    request: RpcEnvelope<Input.EmptyInput>;
    response: Response.WorkSchedule;
  };
  'attendance.v1.time-zones.list': {
    request: RpcEnvelope<Input.TimeZonesInput>;
    response: Response.TimeZoneChoices;
  };
  'attendance.v1.schedule.preview': {
    request: RpcEnvelope<Input.ScheduleInput>;
    response: Response.SchedulePreview;
  };
  'attendance.v1.schedule.change': {
    request: RpcWriteEnvelope<Input.ScheduleInput>;
    response: RpcCommandReply<Response.ScheduleChanged>;
  };
  'attendance.v1.schedule.versions': {
    request: RpcEnvelope<Input.PageInput>;
    response: Response.ScheduleHistoryPage;
  };
  'attendance.v1.holidays.get': {
    request: RpcEnvelope<Input.HolidayYearInput>;
    response: Response.HolidayCalendar;
  };
  'attendance.v1.holidays.preview': {
    request: RpcEnvelope<Input.HolidayChangeInput>;
    response: Response.ChangeImpact;
  };
  'attendance.v1.holidays.change': {
    request: RpcWriteEnvelope<Input.HolidayChangeInput>;
    response: RpcCommandReply<Response.HolidayChanged>;
  };
  'attendance.v1.home.get': {
    request: RpcEnvelope<Input.EmptyInput>;
    response: Response.Home;
  };
  'attendance.v1.check-out': {
    request: RpcWriteEnvelope<Input.CheckOutInput>;
    response: RpcCommandReply<Response.Attendance>;
  };
  'attendance.v1.days.list': {
    request: RpcEnvelope<Input.AttendanceDaysInput>;
    response: Response.AttendanceDayPage;
  };
  'attendance.v1.record.get': {
    request: RpcEnvelope<Input.AttendanceRecordInput>;
    response: Response.Attendance;
  };
  'attendance.v1.monitoring.list': {
    request: RpcEnvelope<Input.MonitoringInput>;
    response: Response.MonitoringPage;
  };
  'attendance.v1.hr-record.get': {
    request: RpcEnvelope<Input.AttendanceRecordInput>;
    response: Response.Attendance;
  };
}
