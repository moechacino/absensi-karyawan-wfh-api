import type { EntityManager } from 'typeorm';
import {
  EmployeeEntity,
  DivisionEntity,
  PositionEntity,
} from '../database/entities';
import { AuthService } from './auth.service';
import type { AuthRepository } from './auth.repository';
import type { PasswordService } from './password.service';
import type { AccessTokenService } from './access-token.service';
import type { LoginThrottle } from './login-throttle.service';

const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'EMPLOYEE' as const,
};

describe('AuthService', () => {
  function setup() {
    const manager = {} as EntityManager;
    const employee = Object.assign(new EmployeeEntity(), {
      ...actor,
      fullName: 'Employee',
      email: 'employee@example.test',
      status: 'ACTIVE' as const,
      hasPasswordChanged: false,
      initialPassword: 'Initial password',
      passwordHash: null,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const repository = {
      transaction: jest.fn(
        async (work: (manager: EntityManager) => Promise<unknown>) =>
          work(manager),
      ),
      findCredentials: jest.fn().mockResolvedValue(employee),
      profile: jest.fn().mockResolvedValue({
        employee,
        division: Object.assign(new DivisionEntity(), {
          id: actor.id,
          code: 'D',
          name: 'Division',
        }),
        position: Object.assign(new PositionEntity(), {
          id: actor.id,
          code: 'P',
          name: 'Position',
        }),
        photo: null,
      }),
      changePassword: jest.fn().mockResolvedValue(undefined),
    };
    const passwords = {
      matches: jest.fn().mockResolvedValue(true),
      hash: jest.fn().mockResolvedValue('argon2-hash'),
    };
    const tokens = {
      issue: jest.fn().mockResolvedValue({ accessToken: 'test-token' }),
    };
    const throttle = { check: jest.fn() };
    const service = new AuthService(
      repository as unknown as AuthRepository,
      passwords as unknown as PasswordService,
      tokens as unknown as AccessTokenService,
      throttle as unknown as LoginThrottle,
    );

    return {
      service,
      repository,
      employee,
      passwords,
      tokens,
      throttle,
      manager,
    };
  }

  it('grants initial users full role access while exposing only explicit profile fields', async () => {
    const { service, tokens, throttle } = setup();
    const result = await service.login(
      { email: 'employee@example.test', password: 'Initial password' },
      '127.0.0.1',
    );
    expect(result.employee.hasPasswordChanged).toBe(false);
    expect(result.employee.passwordPolicy).toEqual({
      minLength: 8,
      maxLength: 128,
      requiresDifferentPassword: true,
    });
    expect(result.employee.permissions).toEqual(['SELF_SERVICE']);
    expect(result.employee).not.toHaveProperty('initialPassword');
    expect(result.employee).not.toHaveProperty('passwordHash');
    expect(tokens.issue).toHaveBeenCalledWith(actor);
    expect(throttle.check).toHaveBeenCalledWith(
      '127.0.0.1',
      'employee@example.test',
    );
  });

  it.each(['missing', 'incorrect', 'inactive'])(
    'returns the same login error for %s',
    async (scenario) => {
      const { service, repository, passwords, employee, tokens } = setup();

      if (scenario === 'missing') {
        repository.findCredentials.mockResolvedValue(null);
      }

      if (scenario === 'incorrect') {
        passwords.matches.mockResolvedValue(false);
      }

      if (scenario === 'inactive') {
        employee.status = 'INACTIVE' as any;
      }

      await expect(
        service.login({ email: employee.email, password: 'wrong' }, 'ip'),
      ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
      expect(tokens.issue).not.toHaveBeenCalled();
    },
  );

  it('uses issued role permissions when current account details have changed', async () => {
    const { service, employee } = setup();
    employee.role = 'HRD' as any;
    employee.status = 'INACTIVE' as any;
    const result = await service.me(actor);
    expect(result.passwordPolicy.minLength).toBe(8);
    expect(result.role).toBe('HRD');
    expect(result.status).toBe('INACTIVE');
    expect(result.permissions).toEqual(['SELF_SERVICE']);
  });

  it.each(['abcdefgh', '😀'.repeat(8), 'x'.repeat(128)])(
    'accepts an allowed password %s after current-password verification',
    async (password) => {
      const { service, repository, employee, manager, passwords } = setup();
      await service.changePassword(actor, {
        currentPassword: 'old',
        newPassword: password,
        confirmPassword: password,
      });
      expect(passwords.hash).toHaveBeenCalledWith(password);
      expect(repository.changePassword).toHaveBeenCalledWith(
        manager,
        employee,
        'argon2-hash',
      );
    },
  );

  it.each([
    {
      newPassword: 'abcdefg',
      confirmPassword: 'abcdefg',
      code: 'PASSWORD_POLICY',
    },
    {
      newPassword: '😀'.repeat(7),
      confirmPassword: '😀'.repeat(7),
      code: 'PASSWORD_POLICY',
    },
    {
      newPassword: 'x'.repeat(129),
      confirmPassword: 'x'.repeat(129),
      code: 'PASSWORD_POLICY',
    },
    {
      newPassword: 'new-password-long',
      confirmPassword: 'different',
      code: 'PASSWORD_MISMATCH',
    },
    {
      newPassword: 'old-password-long',
      confirmPassword: 'old-password-long',
      code: 'PASSWORD_REUSED',
    },
  ])(
    'rejects $code before credential updates',
    async ({ newPassword, confirmPassword, code }) => {
      const { service, repository } = setup();
      await expect(
        service.changePassword(actor, {
          currentPassword: 'old-password-long',
          newPassword,
          confirmPassword,
        }),
      ).rejects.toMatchObject({ code });
      expect(repository.changePassword).not.toHaveBeenCalled();
    },
  );

  it('does not hash or write when current password verification fails', async () => {
    const { service, passwords, repository } = setup();
    passwords.matches.mockResolvedValue(false);
    await expect(
      service.changePassword(actor, {
        currentPassword: 'wrong',
        newPassword: 'new-password-long',
        confirmPassword: 'new-password-long',
      }),
    ).rejects.toMatchObject({ code: 'CURRENT_PASSWORD_INCORRECT' });
    expect(passwords.hash).not.toHaveBeenCalled();
    expect(repository.changePassword).not.toHaveBeenCalled();
  });
});
