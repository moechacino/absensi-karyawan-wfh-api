import type { EntityManager } from 'typeorm';
import {
  EmployeeEntity,
  DivisionEntity,
  PositionEntity,
  FileObjectEntity,
} from '../database/entities';
import type { AuthRepository } from '../auth/auth.repository';
import type { FileService } from '../files/file.service';
import type { StagedImage } from '../files/file.types';
import type { EmployeeCreate, EmployeePatch } from './employee.dto';
import type { EmployeeRepository } from './employee.repository';
import { EmployeeService } from './employee.service';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const divisionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const positionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const otherDivisionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const oldPhotoId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const photo: StagedImage = {
  id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  objectKey: 'private-photo.png',
  ownerEmployeeId: id,
  purpose: 'EMPLOYEE_PROFILE_PHOTO',
  fileName: 'photo.png',
  mimeType: 'image/png',
  sizeBytes: 100,
  sha256: 'a'.repeat(64),
};
const createInput = {
  fullName: 'Employee',
  email: 'employee@example.test',
  divisionId,
  positionId,
  role: 'EMPLOYEE',
  status: 'ACTIVE',
} satisfies EmployeeCreate;

describe('EmployeeService', () => {
  function setup() {
    const manager = {} as EntityManager;
    const employee = Object.assign(new EmployeeEntity(), {
      id,
      ...createInput,
      version: 3,
      photoFileId: oldPhotoId,
      hasPasswordChanged: false,
      initialPassword: 'Fictional-initial-password',
      passwordHash: null,
      createdAt: new Date('2026-11-01T00:00:00Z'),
      updatedAt: new Date('2026-11-01T00:00:00Z'),
    });
    const division = Object.assign(new DivisionEntity(), {
      id: divisionId,
      code: 'D',
      name: 'Division',
      status: 'ACTIVE',
    });
    const position = Object.assign(new PositionEntity(), {
      id: positionId,
      code: 'P',
      name: 'Position',
      divisionId,
      division,
      status: 'ACTIVE',
    });

    const read = (): EmployeeEntity =>
      Object.assign(new EmployeeEntity(), employee, {
        division,
        position,
        photo: employee.photoFileId
          ? Object.assign(new FileObjectEntity(), photo, {
              id: employee.photoFileId,
              state: 'ATTACHED',
            })
          : null,
      });

    const repository = {
      transaction: jest.fn(
        async (work: (manager: EntityManager) => Promise<unknown>) =>
          work(manager),
      ),
      employee: jest.fn(async (): Promise<EmployeeEntity | null> =>
        Object.assign(new EmployeeEntity(), employee),
      ),
      position: jest.fn().mockResolvedValue(position),
      list: jest.fn(async (): Promise<[EmployeeEntity[], number]> => [
        [read()],
        1,
      ]),
      profile: jest.fn(async (): Promise<EmployeeEntity | null> => read()),
      insertEmployee: jest.fn(
        async (_manager: EntityManager, data: Partial<EmployeeEntity>) => {
          Object.assign(employee, data);
        },
      ),
      updateEmployee: jest.fn(
        async (
          _manager: EntityManager,
          _id: string,
          changes: Partial<EmployeeEntity>,
        ) => {
          Object.assign(employee, changes);
        },
      ),
    };
    const profiles = {
      findCredentials: jest.fn().mockResolvedValue(employee),
    };
    const files = { attach: jest.fn().mockResolvedValue(undefined) };
    const service = new EmployeeService(
      repository as unknown as EmployeeRepository,
      profiles as unknown as AuthRepository,
      files as unknown as FileService,
    );

    return {
      service,
      repository,
      profiles,
      files,
      employee,
      division,
      position,
      manager,
    };
  }

  it('returns a public employee with its photo while excluding credentials and auth-only fields', async () => {
    const { service, employee } = setup();
    const result = await service.get(id);
    expect(result).toMatchObject({
      id,
      hasPasswordChanged: false,
      photo: { id: oldPhotoId, contentPath: `/api/v1/files/${oldPhotoId}` },
    });

    for (const key of [
      'initialPassword',
      'passwordHash',
      'permissions',
      'passwordPolicy',
    ]) {
      expect(result).not.toHaveProperty(key);
    }

    expect(JSON.stringify(result)).not.toContain(employee.initialPassword!);
    expect(JSON.stringify(result)).not.toContain(photo.objectKey);
  });

  it('reads employee details without a transaction, lock or duplicate employee lookup', async () => {
    const { service, repository } = setup();
    await service.get(id);
    expect(repository.profile).toHaveBeenCalledWith(id, undefined);
    expect(repository.employee).not.toHaveBeenCalled();
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  it('maps list pagination and represents absent photos explicitly', async () => {
    const { service, employee } = setup();
    employee.photoFileId = null as any;
    const result = await service.list({ page: 1, pageSize: 20 });
    expect(result.pagination).toEqual({
      page: 1,
      pageSize: 20,
      totalItems: 1,
      totalPages: 1,
    });
    expect(result.items[0].photo).toBeNull();
    expect(result.items[0]).not.toHaveProperty('initialPassword');
  });

  it('maps a whole employee page without transactions or per-employee reads', async () => {
    const { service, repository, profiles } = setup();
    const first = await repository.profile();
    const rows = [
      first!,
      Object.assign(new EmployeeEntity(), first, { id: otherDivisionId }),
      Object.assign(new EmployeeEntity(), first, { id: positionId }),
    ];
    repository.list.mockResolvedValue([rows, 3]);
    repository.profile.mockClear();
    const result = await service.list({ page: 1, pageSize: 20 });
    expect(result.items.map((employee) => employee.id)).toEqual([
      id,
      otherDivisionId,
      positionId,
    ]);
    expect(result.pagination.totalItems).toBe(3);
    expect(repository.list).toHaveBeenCalledTimes(1);
    expect(repository.profile).not.toHaveBeenCalled();
    expect(repository.employee).not.toHaveBeenCalled();
    expect(repository.transaction).not.toHaveBeenCalled();
    expect(profiles.findCredentials).not.toHaveBeenCalled();
  });

  it.each(['wrong owner', 'retired', 'wrong purpose'])(
    'omits a joined photo with %s',
    async (scenario) => {
      const { service, repository } = setup();
      const employee = await repository.profile();

      if (scenario === 'wrong owner')
        employee!.photo!.ownerEmployeeId = otherDivisionId;

      if (scenario === 'retired') employee!.photo!.state = 'RETIRED';

      if (scenario === 'wrong purpose')
        employee!.photo!.purpose = 'CHECK_IN_PHOTO';

      repository.profile.mockResolvedValue(employee);
      await expect(service.get(id)).resolves.toHaveProperty('photo', null);
    },
  );

  it('returns an empty page without loading employee profiles', async () => {
    const { service, repository } = setup();
    repository.list.mockResolvedValue([[], 0]);
    const result = await service.list({ page: 2, pageSize: 20 });
    expect(result.items).toEqual([]);
    expect(result.pagination.totalPages).toBe(0);
    expect(repository.employee).not.toHaveBeenCalled();
    expect(repository.profile).not.toHaveBeenCalled();
  });

  it.each(['get', 'update', 'role'] as const)(
    'reports missing targets for %s without writes',
    async (operation) => {
      const { service, repository, manager } = setup();
      repository.employee.mockResolvedValue(null);
      repository.profile.mockResolvedValue(null);

      const result =
        operation === 'get'
          ? service.get(id)
          : operation === 'update'
            ? service.update(
                id,
                { expectedVersion: 3, fullName: 'New' },
                manager,
              )
            : service.role(id, {
                expectedVersion: 3,
                role: 'EMPLOYEE',
                confirmHrAccess: false,
              });
      await expect(result).rejects.toMatchObject({
        code: 'EMPLOYEE_NOT_FOUND',
      });
      expect(repository.updateEmployee).not.toHaveBeenCalled();
    },
  );

  it('creates fresh random initial credentials and keeps creation writes in the supplied transaction', async () => {
    const { service, repository, manager, files } = setup();
    const first = await service.create(createInput, manager);
    const second = await service.create(
      { ...createInput, email: 'other@example.test' },
      manager,
    );
    const firstRow = repository.insertEmployee.mock.calls[0][1];
    const secondRow = repository.insertEmployee.mock.calls[1][1];
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
    expect(firstRow).toMatchObject({
      id: first,
      hasPasswordChanged: false,
      passwordHash: null,
      photoFileId: null,
    });
    expect(firstRow.initialPassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(firstRow.initialPassword).not.toBe(secondRow.initialPassword);
    expect(repository.insertEmployee.mock.calls[0][0]).toBe(manager);
    expect(repository.transaction).not.toHaveBeenCalled();
    expect(files.attach).not.toHaveBeenCalled();
  });

  it('attaches a creation photo through the same manager after inserting its owner', async () => {
    const { service, repository, files, manager } = setup();
    files.attach.mockImplementation(async () => {
      expect(repository.insertEmployee).toHaveBeenCalled();
    });
    await expect(service.create(createInput, manager, id, photo)).resolves.toBe(
      id,
    );
    expect(files.attach).toHaveBeenCalledWith(manager, photo);
    expect(repository.updateEmployee).toHaveBeenCalledWith(manager, id, {
      photoFileId: photo.id,
    });
  });

  it.each([undefined, false])(
    'rejects an unconfirmed HRD creation (%s) before writes',
    async (confirmHrAccess) => {
      const { service, repository, manager } = setup();
      await expect(
        service.create(
          { ...createInput, role: 'HRD', confirmHrAccess },
          manager,
        ),
      ).rejects.toMatchObject({ code: 'HR_CONFIRMATION_REQUIRED' });
      expect(repository.insertEmployee).not.toHaveBeenCalled();
      expect(repository.position).not.toHaveBeenCalled();
    },
  );

  it('allows an explicitly confirmed HRD creation', async () => {
    const { service, repository, manager } = setup();
    await service.create(
      { ...createInput, role: 'HRD', confirmHrAccess: true },
      manager,
    );
    expect(repository.insertEmployee).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ role: 'HRD' }),
    );
  });

  it.each([
    'missing division',
    'missing position',
    'inactive division',
    'inactive position',
    'mismatched position',
  ])(
    'rejects creation with a %s before inserting the employee',
    async (scenario) => {
      const { service, repository, division, position, manager } = setup();

      if (scenario === 'missing division')
        repository.position.mockResolvedValue({
          id: position.id,
          divisionId: position.divisionId,
          status: position.status,
          division: null,
        });

      if (scenario === 'missing position')
        repository.position.mockResolvedValue(null);

      if (scenario === 'inactive division') division.status = 'INACTIVE';

      if (scenario === 'inactive position') position.status = 'INACTIVE';

      if (scenario === 'mismatched position')
        position.divisionId = otherDivisionId;

      await expect(service.create(createInput, manager)).rejects.toMatchObject({
        code: 'INVALID_POSITION_DIVISION',
      });
      expect(repository.insertEmployee).not.toHaveBeenCalled();
    },
  );

  it.each(['create', 'update'] as const)(
    'maps duplicate email failures for %s without exposing SQL',
    async (operation) => {
      const { service, repository, manager } = setup();
      const failure = {
        driverError: { code: 'ER_DUP_ENTRY', sql: 'private SQL' },
      };
      repository.insertEmployee.mockRejectedValue(failure);
      repository.updateEmployee.mockRejectedValue(failure);
      const result =
        operation === 'create'
          ? service.create(createInput, manager)
          : service.update(
              id,
              { expectedVersion: 3, email: 'used@example.test' },
              manager,
            );
      await expect(result).rejects.toMatchObject({
        code: 'EMAIL_ALREADY_USED',
        publicOptions: {},
      });
    },
  );

  it('preserves unexpected database errors for transaction rollback and boundary sanitization', async () => {
    const { service, repository, manager, files } = setup();
    const failure = new Error('Database unavailable');
    repository.insertEmployee.mockRejectedValue(failure);
    await expect(service.create(createInput, manager, id, photo)).rejects.toBe(
      failure,
    );
    expect(files.attach).not.toHaveBeenCalled();
  });

  it('propagates photo attachment failures to the owning transaction without committing a reference', async () => {
    const { service, repository, files, manager } = setup();
    const failure = new Error('Photo metadata failed');
    files.attach.mockRejectedValue(failure);
    await expect(service.create(createInput, manager, id, photo)).rejects.toBe(
      failure,
    );
    expect(repository.updateEmployee).not.toHaveBeenCalled();
  });

  it('projects current email and initial credentials on creation replay without recreating the account', async () => {
    const { service, employee, repository, profiles, manager } = setup();
    employee.email = 'current@example.test';
    const result = await service.created(manager, id, true);
    expect(result.initialCredentials).toEqual({
      email: employee.email,
      initialPassword: employee.initialPassword,
    });
    expect(profiles.findCredentials).toHaveBeenCalledWith(manager, { id });
    expect(repository.insertEmployee).not.toHaveBeenCalled();
    expect(repository.updateEmployee).not.toHaveBeenCalled();
  });

  it.each(['changed', 'cleared'] as const)(
    'rejects %s initial credentials for both explicit reads and replay',
    async (state) => {
      const { service, employee, manager } = setup();
      employee.hasPasswordChanged = state === 'changed';
      employee.initialPassword =
        state === 'cleared' ? (null as any) : employee.initialPassword;
      await expect(service.initialCredentials(id)).rejects.toMatchObject({
        code: 'INITIAL_CREDENTIALS_UNAVAILABLE',
        publicOptions: { details: { employeeId: id } },
      });
      await expect(service.created(manager, id, true)).rejects.toMatchObject({
        code: 'INITIAL_CREDENTIALS_UNAVAILABLE',
        publicOptions: { details: { employeeId: id, alreadyCreated: true } },
      });
    },
  );

  it('returns credentials from the current source for an explicit read', async () => {
    const { service, employee, profiles, manager } = setup();
    await expect(service.initialCredentials(id)).resolves.toEqual({
      employeeId: id,
      initialCredentials: {
        email: employee.email,
        initialPassword: employee.initialPassword,
      },
    });
    expect(profiles.findCredentials).toHaveBeenCalledWith(manager, { id });
  });

  it('reports a missing credential target without loading its profile', async () => {
    const { service, profiles, repository, manager } = setup();
    profiles.findCredentials.mockResolvedValue(null);
    await expect(service.initialCredentials(id)).rejects.toMatchObject({
      code: 'EMPLOYEE_NOT_FOUND',
    });
    await expect(service.created(manager, id, true)).rejects.toMatchObject({
      code: 'EMPLOYEE_NOT_FOUND',
    });
    expect(repository.employee).not.toHaveBeenCalled();
  });

  it('rejects conflicting photo actions and patches containing no meaningful edit', () => {
    const { service } = setup();
    expect(() =>
      service.validatePatch({ expectedVersion: 3, removePhoto: true }, true),
    ).toThrow('upload or removal');
    expect(() => service.validatePatch({ expectedVersion: 3 }, false)).toThrow(
      'editable field',
    );
    expect(() =>
      service.validatePatch({ expectedVersion: 3, removePhoto: false }, false),
    ).toThrow('editable field');
  });

  it.each([
    { input: { expectedVersion: 3 }, hasPhoto: true },
    { input: { expectedVersion: 3, removePhoto: true }, hasPhoto: false },
    { input: { expectedVersion: 3, fullName: 'New' }, hasPhoto: false },
  ])('accepts a meaningful patch action: %p', ({ input, hasPhoto }) => {
    expect(() => setup().service.validatePatch(input, hasPhoto)).not.toThrow();
  });

  it.each(['update', 'role'] as const)(
    'rejects stale %s commands before writing',
    async (operation) => {
      const { service, repository, files, manager } = setup();
      const result =
        operation === 'update'
          ? service.update(
              id,
              { expectedVersion: 2, fullName: 'New' },
              manager,
              photo,
            )
          : service.role(id, {
              expectedVersion: 2,
              role: 'EMPLOYEE',
              confirmHrAccess: false,
            });
      await expect(result).rejects.toMatchObject({
        code: 'VERSION_CONFLICT',
        publicOptions: { details: { resourceId: id, currentVersion: 3 } },
      });
      expect(repository.updateEmployee).not.toHaveBeenCalled();
      expect(files.attach).not.toHaveBeenCalled();
    },
  );

  it.each(['omit', 'replace', 'remove'] as const)(
    'handles photo %s without changing credentials',
    async (action) => {
      const { service, repository, files, employee, manager } = setup();
      const credentials = {
        initialPassword: employee.initialPassword,
        hasPasswordChanged: employee.hasPasswordChanged,
      };
      const input: EmployeePatch = {
        expectedVersion: 3,
        fullName: 'Edited',
        ...(action === 'remove' ? { removePhoto: true } : {}),
      };
      const result = await service.update(
        id,
        input,
        manager,
        action === 'replace' ? photo : undefined,
      );
      expect(result.employee.fullName).toBe('Edited');
      expect(result.employee.version).toBe(4);
      expect(result.replacedPhotoId).toBe(
        action === 'omit' ? null : oldPhotoId,
      );
      expect(employee.photoFileId).toBe(
        action === 'omit' ? oldPhotoId : action === 'replace' ? photo.id : null,
      );
      expect(employee).toMatchObject(credentials);
      expect(repository.transaction).not.toHaveBeenCalled();

      if (action === 'replace') {
        expect(files.attach).toHaveBeenCalledWith(manager, photo);
      } else {
        expect(files.attach).not.toHaveBeenCalled();
      }
    },
  );

  it('requires an explicit compatible position when changing division', async () => {
    const { service, repository, manager } = setup();
    await expect(
      service.update(
        id,
        { expectedVersion: 3, divisionId: otherDivisionId },
        manager,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_POSITION_DIVISION' });
    expect(repository.updateEmployee).not.toHaveBeenCalled();
  });

  it('allows moving to an active compatible division and position', async () => {
    const { service, repository, division, position, manager } = setup();
    division.id = otherDivisionId;
    position.divisionId = otherDivisionId;
    await service.update(
      id,
      { expectedVersion: 3, divisionId: otherDivisionId, positionId },
      manager,
    );
    expect(repository.position).toHaveBeenCalledWith(manager, positionId, true);
    expect(repository.updateEmployee).toHaveBeenCalledWith(manager, id, {
      divisionId: otherDivisionId,
      positionId,
      version: 4,
    });
  });

  it('allows unrelated edits with historical inactive references but blocks reactivation', async () => {
    const { service, repository, employee, division, position, manager } =
      setup();
    division.status = 'INACTIVE';
    position.status = 'INACTIVE';
    employee.status = 'INACTIVE' as any;
    await expect(
      service.update(
        id,
        { expectedVersion: 3, fullName: 'Historical' },
        manager,
      ),
    ).resolves.toHaveProperty('employee.fullName', 'Historical');
    expect(repository.position).not.toHaveBeenCalled();
    await expect(
      service.update(id, { expectedVersion: 4, status: 'ACTIVE' }, manager),
    ).rejects.toMatchObject({ code: 'INVALID_POSITION_DIVISION' });
    expect(employee.status).toBe('INACTIVE');
  });

  it('requires confirmation before granting HRD access through the role command', () => {
    const { service, repository } = setup();
    expect(() =>
      service.role(id, {
        expectedVersion: 3,
        role: 'HRD',
        confirmHrAccess: false,
      }),
    ).toThrow('Confirm HRD access');
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  it('changes role using the repository transaction while preserving all credential state', async () => {
    const { service, repository, employee, manager } = setup();
    employee.hasPasswordChanged = true;
    employee.initialPassword = null as any;
    employee.passwordHash = 'fictional-personal-password-hash' as any;
    const result = await service.role(id, {
      expectedVersion: 3,
      role: 'HRD',
      confirmHrAccess: true,
    });
    expect(result.role).toBe('HRD');
    expect(result.version).toBe(4);
    expect(repository.updateEmployee).toHaveBeenCalledWith(manager, id, {
      role: 'HRD',
      version: 4,
    });
    expect(employee).toMatchObject({
      hasPasswordChanged: true,
      initialPassword: null,
      passwordHash: 'fictional-personal-password-hash',
    });
  });
});
