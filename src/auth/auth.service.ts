import { Injectable } from '@nestjs/common';
import { ProblemException } from '../http/problem';
import { AuthRepository } from './auth.repository';
import { PasswordService } from './password.service';
import { AccessTokenService } from './access-token.service';
import type { Actor } from './access-token.service';
import { LoginThrottle } from './login-throttle.service';
import { mapProfile } from './profile';
import type { LoginResult, MeProfile } from './auth.types';
import type { LoginInput, PasswordInput } from './auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly tokens: AccessTokenService,
    private readonly throttle: LoginThrottle,
  ) {}

  async login(input: LoginInput, ip: string): Promise<LoginResult> {
    this.throttle.check(ip, input.email);
    const employee = await this.repository.transaction(async (manager) => {
      const account = await this.repository.findCredentials(manager, {
        email: input.email,
      });
      const matches = await this.passwords.matches(account, input.password);

      if (!account || !matches || account.status !== 'ACTIVE') {
        throw new ProblemException(
          401,
          'INVALID_CREDENTIALS',
          'Invalid email or password',
        );
      }

      return mapProfile(
        await this.repository.profile(manager, account.id),
        account.role,
      );
    });
    const grant = await this.tokens.issue({
      id: employee.id,
      role: employee.role,
    });

    return { ...grant, employee };
  }

  me(actor: Actor): Promise<MeProfile> {
    return this.repository.transaction(async (manager) =>
      mapProfile(await this.repository.profile(manager, actor.id), actor.role),
    );
  }

  async changePassword(actor: Actor, input: PasswordInput): Promise<void> {
    if (
      Array.from(input.newPassword).length < 8 ||
      Array.from(input.newPassword).length > 128
    ) {
      throw new ProblemException(
        422,
        'PASSWORD_POLICY',
        'Password must contain 8–128 Unicode code points',
      );
    }

    if (input.newPassword !== input.confirmPassword) {
      throw new ProblemException(
        422,
        'PASSWORD_MISMATCH',
        'Password confirmation differs',
      );
    }

    if (input.newPassword === input.currentPassword) {
      throw new ProblemException(
        422,
        'PASSWORD_REUSED',
        'Choose a different password',
      );
    }

    await this.repository.transaction(async (manager) => {
      const employee = await this.repository.findCredentials(manager, {
        id: actor.id,
      });

      if (
        !employee ||
        !(await this.passwords.matches(employee, input.currentPassword))
      ) {
        throw new ProblemException(
          422,
          'CURRENT_PASSWORD_INCORRECT',
          'Current password incorrect',
        );
      }

      const hash = await this.passwords.hash(input.newPassword);
      await this.repository.changePassword(manager, employee, hash);
    });
  }
}
