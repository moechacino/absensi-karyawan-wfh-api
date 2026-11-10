import type {
  Attendance,
  AttendancePhoto,
  ScheduleSnapshot,
} from '../attendance-rpc/rpc.responses';
import { checkoutTiming } from './checkout.rules';
import type { AttendanceEntity, FileObjectEntity } from '../database/entities';

type Photo = Pick<
  FileObjectEntity,
  'id' | 'fileName' | 'mimeType' | 'sizeBytes' | 'purpose'
>;

export function attendanceView(
  row: AttendanceEntity,
  photo: Photo = row.photo,
  at?: Date,
  deadline: string | null = null,
): Attendance {
  const metadata: AttendancePhoto = {
    id: photo.id,
    fileName: photo.fileName,
    mimeType: photo.mimeType,
    sizeBytes: photo.sizeBytes,
    purpose: 'CHECK_IN_PHOTO',
    contentPath: `/api/v1/files/${photo.id}`,
  };

  return {
    ...checkoutTiming(row.checkOutAt, row.plannedEndAt),
    checkOutDeadlineAt: deadline,
    id: row.id,
    employeeId: row.employeeId,
    workDate: row.workDate,
    state: row.checkOutAt
      ? 'COMPLETED'
      : row.missedCheckOut ||
          (at && deadline && at.getTime() >= Date.parse(deadline))
        ? 'MISSED_CHECK_OUT'
        : 'WORKING',
    schedule: attendanceSnapshot(row),
    checkInAt: row.checkInAt.toISOString(),
    checkOutAt: row.checkOutAt?.toISOString() ?? null,
    punctuality: row.punctuality,
    lateSeconds: row.lateSeconds,
    durationSeconds: row.durationSeconds,
    photo: metadata,
    version: row.version,
  };
}

export function attendanceSnapshot(row: AttendanceEntity): ScheduleSnapshot {
  return {
    opensMinutesBeforeStart: row.opensMinutesBeforeStart ?? 15,
    scheduleVersionId: row.scheduleVersionId,
    workDate: row.workDate,
    timeZone: row.timeZone,
    plannedStartAt: row.plannedStartAt.toISOString(),
    plannedEndAt: row.plannedEndAt.toISOString(),
  };
}
