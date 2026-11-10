// Response types aligned with the active contracts/openapi.json schemas.
// Transport-only types; business behavior belongs to the owning feature tasks.

export type Actor = {
  id: string;
  fullName: string;
};

export type Attendance = {
  id: string;
  employeeId: string;
  workDate: string;
  state: 'WORKING' | 'COMPLETED' | 'MISSED_CHECK_OUT';
  schedule: ScheduleSnapshot;
  checkInAt: string;
  checkOutAt: string | null;
  checkOutDeadlineAt: string | null;
  checkOutPunctuality: 'EARLY' | 'ON_TIME' | 'LATE' | null;
  earlyCheckOutSeconds: number | null;
  punctuality: 'ON_TIME' | 'LATE';
  lateSeconds: number;
  durationSeconds: number | null;
  photo: AttendancePhoto;
  version: number;
};

export type AttendanceDay = {
  workDate: string;
  status:
    | 'NOT_CHECKED_IN'
    | 'WORKING'
    | 'COMPLETED'
    | 'MISSED_CHECK_OUT'
    | 'HOLIDAY'
    | 'REST_DAY'
    | 'UNCONFIGURED';
  schedule: ScheduleSnapshot | null;
  attendance: Attendance | null;
  canCheckIn: boolean;
  canCheckOut: boolean;
  blockReason:
    | 'SCHEDULE_NOT_CONFIGURED'
    | 'REST_DAY'
    | 'COMPANY_HOLIDAY'
    | 'CHECK_IN_TOO_EARLY'
    | 'CHECK_IN_WINDOW_CLOSED'
    | 'ALREADY_CHECKED_IN'
    | 'ALREADY_CHECKED_OUT'
    | 'MISSED_CHECK_OUT'
    | null;
};

export type AttendanceDayPage = {
  items: Array<AttendanceDay>;
  pagination: Pagination;
};

export type AttendancePhoto = FileMetadata & {
  purpose?: 'CHECK_IN_PHOTO';
  mimeType?: 'image/jpeg' | 'image/png' | 'image/webp';
};

export type ChangeImpact = {
  canApply: boolean;
  issues: Array<Issue>;
};

export type CheckInPolicy = {
  opensMinutesBeforeStart: number;
  lateAfterMinutes: 0;
};

export type CheckInWindow = {
  opensAt: string;
  deadlineAt: string;
  closesAt: string;
};

export type EmployeeSummary = {
  id: string;
  fullName: string;
  division: MasterSummary;
  position: MasterSummary;
  photo: ProfilePhoto | null;
};

export type FileMetadata = {
  id: string;
  fileName: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  sizeBytes: number;
  purpose: 'CHECK_IN_PHOTO' | 'EMPLOYEE_PROFILE_PHOTO';
  contentPath: string;
};

export type Holiday = {
  date: string;
  name: string;
  category: 'COMPANY' | 'PUBLIC' | 'OTHER';
};

export type HolidayCalendar = {
  year: number;
  version: number;
  items: Array<Holiday>;
};

export type HolidayChanged = {
  calendar: HolidayCalendar;
};

export type Home = {
  serverNow: string;
  companyDate: string;
  timeZone: string;
  day: AttendanceDay;
  workSchedule: WorkSchedule;
  checkInWindow: CheckInWindow | null;
};

export type Issue = {
  code: string;
  field: string | null;
  message: string;
};

export type MasterSummary = {
  id: string;
  code: string;
  name: string;
};

export type MonitoringPage = {
  items: Array<MonitoringRow>;
  pagination: Pagination;
  summary: {
    notCheckedIn: number;
    working: number;
    completed: number;
    missedCheckOut: number;
    late: number;
    holiday: number;
    restDay: number;
    unconfigured: number;
  };
};

export type MonitoringRow = {
  employee: EmployeeSummary;
  day: AttendanceDay;
};

export type Pagination = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

export type ProfilePhoto = FileMetadata & {
  purpose?: 'EMPLOYEE_PROFILE_PHOTO';
  mimeType?: 'image/jpeg' | 'image/png' | 'image/webp';
};

export type ScheduleChange = {
  opensMinutesBeforeStart?: number;
  expectedVersion: number;
  workingDays: Array<number>;
  startTime: string;
  endTime: string;
  endDayOffset: 0 | 1;
  timeZone: string;
  effectiveFrom: string;
};

export type ScheduleChanged = {
  schedule: WorkSchedule;
};

export type ScheduleHistoryPage = {
  items: Array<ScheduleVersion>;
  pagination: Pagination;
};

export type SchedulePreview = {
  schedule: ScheduleChange;
  activationMode: 'ON_SAVE' | 'AT_INSTANT';
  effectiveAt: string | null;
  comparisonDate: string;
  impact: ChangeImpact;
};

export type ScheduleSnapshot = {
  opensMinutesBeforeStart?: number;
  scheduleVersionId: string;
  workDate: string;
  timeZone: string;
  plannedStartAt: string;
  plannedEndAt: string;
};

export type ScheduleVersion = {
  opensMinutesBeforeStart?: number;
  id: string;
  workingDays: Array<number>;
  startTime: string;
  endTime: string;
  endDayOffset: 0 | 1;
  timeZone: string;
  effectiveFrom: string;
  effectiveAt: string;
  state: 'ACTIVE' | 'SCHEDULED' | 'SUPERSEDED';
  createdAt: string;
  createdBy: Actor;
};

export type TimeZoneChoice = {
  id: string;
  label: string;
  offsetMinutes: number;
  referenceAt: string;
};

export type TimeZoneChoices = {
  items: Array<TimeZoneChoice>;
};

export type WorkSchedule = {
  version: number;
  current: ScheduleVersion | null;
  upcoming: ScheduleVersion | null;
  checkInPolicy: CheckInPolicy;
};
