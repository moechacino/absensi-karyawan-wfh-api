import { EmployeeEntity } from '../database/entities';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const passwords = new PasswordService();

  it('verifies exact initial credentials and rejects unknown accounts without trimming', async () => {
    const employee = Object.assign(new EmployeeEntity(), {
      hasPasswordChanged: false,
      initialPassword: ' Initial password ',
    });
    await expect(
      passwords.matches(employee, ' Initial password '),
    ).resolves.toBe(true);
    await expect(passwords.matches(employee, 'Initial password')).resolves.toBe(
      false,
    );
    await expect(passwords.matches(null, 'Initial password')).resolves.toBe(
      false,
    );
  });

  it('hashes personal passwords with Argon2id and does not normalize Unicode', async () => {
    const passwordHash = await passwords.hash('é-password-long-enough');
    expect(passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    const employee = Object.assign(new EmployeeEntity(), {
      hasPasswordChanged: true,
      initialPassword: null,
      passwordHash,
    });
    await expect(
      passwords.matches(employee, 'é-password-long-enough'),
    ).resolves.toBe(true);
    await expect(
      passwords.matches(employee, 'e\u0301-password-long-enough'),
    ).resolves.toBe(false);
  });
});
