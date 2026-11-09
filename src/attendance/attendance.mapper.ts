import type {
  Attendance,
  AttendancePhoto,
  ScheduleSnapshot,
} from '../attendance-rpc/rpc.responses';
import type { AttendanceEntity, FileObjectEntity } from '../database/entities';

type Photo = Pick<
  FileObjectEntity,
  'id' | 'fileName' | 'mimeType' | 'sizeBytes' | 'purpose'
>;

export function attendanceView(
  row: AttendanceEntity,
  photo: Photo = row.photo,
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
    id: row.id,
    employeeId: row.employeeId,
    workDate: row.workDate,
    state: row.checkOutAt ? 'COMPLETED' : 'WORKING',
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
    scheduleVersionId: row.scheduleVersionId,
    workDate: row.workDate,
    timeZone: row.timeZone,
    plannedStartAt: row.plannedStartAt.toISOString(),
    plannedEndAt: row.plannedEndAt.toISOString(),
  };
}
