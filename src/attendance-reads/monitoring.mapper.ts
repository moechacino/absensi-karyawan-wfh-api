import type { EmployeeSummary } from '../attendance-rpc/rpc.responses';
import type { EmployeeEntity } from '../database/entities';

export function monitoringEmployee(row: EmployeeEntity): EmployeeSummary {
  const photo =
    row.photo &&
    row.photo.id === row.photoFileId &&
    row.photo.ownerEmployeeId === row.id &&
    row.photo.state === 'ATTACHED' &&
    row.photo.purpose === 'EMPLOYEE_PROFILE_PHOTO'
      ? row.photo
      : null;

  return {
    id: row.id,
    fullName: row.fullName,
    division: {
      id: row.division.id,
      code: row.division.code,
      name: row.division.name,
    },
    position: {
      id: row.position.id,
      code: row.position.code,
      name: row.position.name,
    },
    photo: photo
      ? {
          id: photo.id,
          fileName: photo.fileName,
          mimeType: photo.mimeType,
          sizeBytes: photo.sizeBytes,
          purpose: 'EMPLOYEE_PROFILE_PHOTO',
          contentPath: `/api/v1/files/${photo.id}`,
        }
      : null,
  };
}
