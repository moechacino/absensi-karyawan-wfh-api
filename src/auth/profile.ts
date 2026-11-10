import type { Actor } from './access-token.service';
import type { AuthRepository } from './auth.repository';

import type { MeProfile, Permission } from './auth.types';

export const permissions = (role: Actor['role']): Permission[] =>
  role === 'HRD'
    ? [
        'SELF_SERVICE',
        'HR_EMPLOYEES_MANAGE',
        'HR_ORGANIZATION_MANAGE',
        'HR_SCHEDULE_MANAGE',
        'HR_HOLIDAYS_MANAGE',
        'HR_ATTENDANCE_READ',
      ]
    : ['SELF_SERVICE'];

export function mapProfile(
  data: Awaited<ReturnType<AuthRepository['profile']>>,
  role: Actor['role'],
): MeProfile {
  const { employee: e, division, position, photo } = data;

  return {
    id: e.id,
    fullName: e.fullName,
    email: e.email,
    role: e.role,
    status: e.status,
    division: { id: division.id, code: division.code, name: division.name },
    position: { id: position.id, code: position.code, name: position.name },
    version: e.version,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    hasPasswordChanged: e.hasPasswordChanged,
    permissions: permissions(role),
    passwordPolicy: {
      minLength: 8,
      maxLength: 128,
      requiresDifferentPassword: true,
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
