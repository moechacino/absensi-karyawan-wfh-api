import { monitoringEmployee } from './monitoring.mapper';
import { EmployeeEntity } from '../database/entities';

const row = () =>
  Object.assign(new EmployeeEntity(), {
    id: 'employee',
    fullName: 'Name',
    division: { id: 'division', code: 'D', name: 'Division' },
    position: { id: 'position', code: 'P', name: 'Position' },
    email: 'private@example.test',
    initialPassword: 'secret',
    passwordHash: 'hash',
    photoFileId: 'photo',
    photo: {
      id: 'photo',
      ownerEmployeeId: 'employee',
      state: 'ATTACHED',
      purpose: 'EMPLOYEE_PROFILE_PHOTO',
      fileName: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 123,
      objectKey: 'private-key',
    },
  });

describe('monitoringEmployee', () => {
  it('returns only the safe summary shape and existing file contentPath', () => {
    expect(monitoringEmployee(row())).toEqual({
      id: 'employee',
      fullName: 'Name',
      division: { id: 'division', code: 'D', name: 'Division' },
      position: { id: 'position', code: 'P', name: 'Position' },
      photo: {
        id: 'photo',
        fileName: 'photo.png',
        mimeType: 'image/png',
        sizeBytes: 123,
        purpose: 'EMPLOYEE_PROFILE_PHOTO',
        contentPath: '/api/v1/files/photo',
      },
    });
  });

  it.each([
    { ownerEmployeeId: 'someone-else' },
    { purpose: 'CHECK_IN_PHOTO' },
    { state: 'RETIRED' },
    { id: 'unbound' },
  ])('does not expose an invalid profile binding %j', (change) => {
    const employee = row();
    Object.assign(employee.photo!, change);
    expect(monitoringEmployee(employee).photo).toBeNull();
  });
});
