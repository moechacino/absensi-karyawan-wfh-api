import { ATTENDANCE_PATTERNS as patterns } from './rpc.contract';

const writes = new Set<string>([
  patterns.scheduleChange,
  patterns.holidaysChange,
  patterns.checkIn,
  patterns.checkOut,
]);
const hrPatterns = new Set<string>([
  patterns.schedulePreview,
  patterns.scheduleChange,
  patterns.scheduleVersions,
  patterns.holidaysPreview,
  patterns.holidaysChange,
  patterns.monitoringList,
  patterns.hrRecordGet,
]);

export function isAttendanceWrite(pattern: string): boolean {
  return writes.has(pattern);
}

export function requiresAttendanceHr(pattern: string): boolean {
  return hrPatterns.has(pattern);
}
