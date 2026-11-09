import type { EmployeeEntity } from '../database/entities';

export function mapEmployee(employee: EmployeeEntity) {
  const { division, position } = employee;
  const photo =
    employee.photo?.id === employee.photoFileId &&
    employee.photo.ownerEmployeeId === employee.id &&
    employee.photo.state === 'ATTACHED' &&
    employee.photo.purpose === 'EMPLOYEE_PROFILE_PHOTO'
      ? employee.photo
      : null;

  return {
    id: employee.id,
    fullName: employee.fullName,
    email: employee.email,
    role: employee.role,
    status: employee.status,
    version: employee.version,
    createdAt: employee.createdAt.toISOString(),
    updatedAt: employee.updatedAt.toISOString(),
    hasPasswordChanged: employee.hasPasswordChanged,
    division: {
      id: division.id,
      code: division.code,
      name: division.name,
    },
    position: {
      id: position.id,
      code: position.code,
      name: position.name,
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
