import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { EmployeeEntity } from '../database/entities';

@Injectable()
export class PasswordService {
  private dummy?: Promise<string>;

  hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
  }

  async matches(
    employee: EmployeeEntity | null,
    password: string,
  ): Promise<boolean> {
    if (employee?.hasPasswordChanged && employee.passwordHash) {
      return argon2.verify(employee.passwordHash, password);
    }

    // Just for simulating delay for security
    this.dummy ??= this.hash(randomBytes(32).toString('hex'));
    await argon2.verify(await this.dummy, password);

    if (!employee || employee.initialPassword === null) {
      return false;
    }

    const digest = (value: string): Buffer =>
      createHash('sha256').update(value).digest();

    return timingSafeEqual(digest(employee.initialPassword), digest(password));
  }
}
