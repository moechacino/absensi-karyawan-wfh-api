import type { ExecutionContext } from '@nestjs/common';
import { OrganizationGuard } from './organization.guard';

describe('OrganizationGuard', () => {
  function context(role: string): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => ({ actor: { role } }) }),
    } as unknown as ExecutionContext;
  }

  it('accepts issued HRD claims', () => {
    expect(new OrganizationGuard().canActivate(context('HRD'))).toBe(true);
  });

  it('rejects employee claims before handlers or interceptors run', () => {
    expect(() =>
      new OrganizationGuard().canActivate(context('EMPLOYEE')),
    ).toThrow('HRD permission required');
  });
});
