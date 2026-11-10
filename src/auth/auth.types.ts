import type { Actor } from './access-token.service';

export type Permission =
  | 'SELF_SERVICE'
  | 'HR_EMPLOYEES_MANAGE'
  | 'HR_ORGANIZATION_MANAGE'
  | 'HR_SCHEDULE_MANAGE'
  | 'HR_HOLIDAYS_MANAGE'
  | 'HR_ATTENDANCE_READ';

export interface MasterSummary {
  id: string;
  code: string;
  name: string;
}

export interface ProfilePhoto {
  id: string;
  fileName: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  sizeBytes: number;
  purpose: 'EMPLOYEE_PROFILE_PHOTO';
  contentPath: string;
}

export interface MeProfile {
  id: string;
  fullName: string;
  email: string;
  role: Actor['role'];
  status: 'ACTIVE' | 'INACTIVE';
  division: MasterSummary;
  position: MasterSummary;
  version: number;
  createdAt: string;
  updatedAt: string;
  hasPasswordChanged: boolean;
  permissions: Permission[];
  passwordPolicy: {
    minLength: 8;
    maxLength: 128;
    requiresDifferentPassword: true;
  };
  photo: ProfilePhoto | null;
}

export interface AccessGrant {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  expiresAt: string;
  serverNow: string;
}

export interface LoginResult extends AccessGrant {
  employee: MeProfile;
}
