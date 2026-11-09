import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { EmployeeEntity } from '../database/entities';
import { AuthRepository } from '../auth/auth.repository';
import { mapEmployee } from './employee.mapper';
import { FileService } from '../files/file.service';
import type { StagedImage } from '../files/file.types';
import { ProblemException } from '../http/problem';
import { page } from '../organization/organization.mapper';
import { mysqlErrorCode } from '../idempotency/idempotency.errors';
import { EmployeeRepository } from './employee.repository';
import type {
  EmployeeCreate,
  EmployeePatch,
  EmployeeQuery,
  RoleChange,
} from './employee.dto';

@Injectable()
export class EmployeeService {
  constructor(
    private readonly repository: EmployeeRepository,
    private readonly profiles: AuthRepository,
    private readonly files: FileService,
  ) {}

  async get(id: string, manager?: EntityManager) {
    const employee = await this.repository.profile(id, manager);

    if (!employee) {
      throw new ProblemException(
        404,
        'EMPLOYEE_NOT_FOUND',
        'Employee not found',
      );
    }

    return mapEmployee(employee);
  }

  async list(query: EmployeeQuery) {
    const [rows, total] = await this.repository.list(query);

    return page(rows.map(mapEmployee), total, query);
  }

  async create(
    input: EmployeeCreate,
    manager: EntityManager,
    id = randomUUID(),
    photo?: StagedImage,
  ): Promise<string> {
    this.confirm(input);
    await this.assignment(manager, input.divisionId, input.positionId);
    await this.unique(() =>
      this.repository.insertEmployee(manager, {
        id,
        fullName: input.fullName,
        email: input.email,
        divisionId: input.divisionId,
        positionId: input.positionId,
        role: input.role,
        status: input.status,
        photoFileId: null,
        hasPasswordChanged: false,
        initialPassword: randomBytes(24).toString('base64url'),
        passwordHash: null,
      }),
    );

    if (photo) {
      await this.files.attach(manager, photo);
      await this.repository.updateEmployee(manager, id, {
        photoFileId: photo.id,
      });
    }

    return id;
  }

  async created(manager: EntityManager, id: string, replayed: boolean) {
    const initialCredentials = await this.credentials(manager, id, replayed);
    return { employee: await this.get(id, manager), initialCredentials };
  }

  initialCredentials(id: string) {
    return this.repository.transaction(async (manager) => ({
      employeeId: id,
      initialCredentials: await this.credentials(manager, id),
    }));
  }

  private async credentials(
    manager: EntityManager,
    id: string,
    alreadyCreated = false,
  ) {
    const employee = await this.profiles.findCredentials(manager, { id });

    if (!employee)
      throw new ProblemException(
        404,
        'EMPLOYEE_NOT_FOUND',
        'Employee not found',
      );

    if (employee.hasPasswordChanged || employee.initialPassword === null) {
      throw new ProblemException(
        409,
        'INITIAL_CREDENTIALS_UNAVAILABLE',
        'Initial credentials unavailable',
        {
          details: {
            employeeId: id,
            ...(alreadyCreated ? { alreadyCreated: true } : {}),
          },
        },
      );
    }

    return { email: employee.email, initialPassword: employee.initialPassword };
  }

  validatePatch(input: EmployeePatch, hasPhoto: boolean): void {
    if (hasPhoto && input.removePhoto)
      throw new ProblemException(
        422,
        'PHOTO_ACTION_CONFLICT',
        'Choose upload or removal',
      );

    if (
      !hasPhoto &&
      !input.removePhoto &&
      !['fullName', 'email', 'divisionId', 'positionId', 'status'].some(
        (key) => Reflect.get(input, key) !== undefined,
      )
    ) {
      throw new ProblemException(
        400,
        'VALIDATION_FAILED',
        'Include at least one editable field',
      );
    }
  }

  async update(
    id: string,
    input: EmployeePatch,
    manager: EntityManager,
    photo?: StagedImage,
  ) {
    const existing = await this.requireEmployee(manager, id, true);
    this.version(existing, input.expectedVersion);
    const divisionId = input.divisionId ?? existing.divisionId;
    const positionId = input.positionId ?? existing.positionId;

    if (divisionId !== existing.divisionId && input.positionId === undefined) {
      throw new ProblemException(
        422,
        'INVALID_POSITION_DIVISION',
        'Choose a compatible position with the division',
      );
    }

    if (
      input.divisionId !== undefined ||
      input.positionId !== undefined ||
      (existing.status === 'INACTIVE' && input.status === 'ACTIVE')
    ) {
      await this.assignment(manager, divisionId, positionId);
    }

    if (photo) await this.files.attach(manager, photo);

    const {
      expectedVersion: _version,
      removePhoto: _remove,
      ...changes
    } = input;
    await this.unique(() =>
      this.repository.updateEmployee(manager, id, {
        ...changes,
        version: existing.version + 1,
        ...(photo
          ? { photoFileId: photo.id }
          : input.removePhoto
            ? { photoFileId: null }
            : {}),
      }),
    );
    return {
      employee: await this.get(id, manager),
      replacedPhotoId: photo || input.removePhoto ? existing.photoFileId : null,
    };
  }

  role(id: string, input: RoleChange) {
    this.confirm(input);
    return this.repository.transaction(async (manager) => {
      const existing = await this.requireEmployee(manager, id, true);
      this.version(existing, input.expectedVersion);
      await this.repository.updateEmployee(manager, id, {
        role: input.role,
        version: existing.version + 1,
      });
      return this.get(id, manager);
    });
  }

  private confirm(input: { role: string; confirmHrAccess?: boolean }): void {
    if (input.role === 'HRD' && input.confirmHrAccess !== true)
      throw new ProblemException(
        422,
        'HR_CONFIRMATION_REQUIRED',
        'Confirm HRD access',
      );
  }

  private version(employee: EmployeeEntity, expected: number): void {
    if (employee.version !== expected)
      throw new ProblemException(
        409,
        'VERSION_CONFLICT',
        'Resource version changed',
        {
          details: {
            resourceId: employee.id,
            currentVersion: employee.version,
          },
        },
      );
  }

  private async requireEmployee(
    manager: EntityManager,
    id: string,
    lock = false,
  ) {
    const employee = await this.repository.employee(manager, id, lock);

    if (!employee)
      throw new ProblemException(
        404,
        'EMPLOYEE_NOT_FOUND',
        'Employee not found',
      );

    return employee;
  }

  private async assignment(
    manager: EntityManager,
    divisionId: string,
    positionId: string,
  ): Promise<void> {
    // Lock the position and its joined division while validating the assignment.
    const position = await this.repository.position(manager, positionId, true);

    if (
      !position ||
      position.divisionId !== divisionId ||
      position.status !== 'ACTIVE' ||
      position.division?.status !== 'ACTIVE'
    ) {
      throw new ProblemException(
        422,
        'INVALID_POSITION_DIVISION',
        'Choose an active compatible division and position',
      );
    }
  }

  private async unique<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (mysqlErrorCode(error) === 'ER_DUP_ENTRY')
        throw new ProblemException(
          409,
          'EMAIL_ALREADY_USED',
          'Email already used',
        );

      throw error;
    }
  }
}
