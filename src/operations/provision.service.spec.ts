import type { EntityManager } from 'typeorm';
import type { RuntimeConfig } from '../runtime/runtime.config';
import { ProvisionService } from './provision.service';
import { ProvisionRepository } from './provision.repository';
import { provisionInput } from './operations.input';

const input = provisionInput({
  fullName: 'First HRD',
  email: 'first@example.test',
  initialPassword: 'Fictional-password-123',
  divisionCode: 'OPS',
  divisionName: 'Operations',
  positionCode: 'HRD',
  positionName: 'HRD',
});

describe('controlled first HRD provisioning', () => {
  const manager = {} as EntityManager;
  const repository = {
    transaction: jest.fn(
      async (work: (manager: EntityManager) => Promise<unknown>) =>
        work(manager),
    ),
    lockInstallation: jest.fn(),
    employeeCount: jest.fn(),
    insert: jest.fn(),
  };
  const service = (environment = 'production') =>
    new ProvisionService(
      repository as unknown as ProvisionRepository,
      { app: { environment } } as RuntimeConfig,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    repository.employeeCount.mockResolvedValue(0);
  });

  it('allows production first-HRD provisioning and locks before inserting all references', async () => {
    const result = await service().firstHrd(input);
    expect(repository.lockInstallation).toHaveBeenCalledWith(manager);
    expect(repository.employeeCount).toHaveBeenCalledWith(manager);
    expect(
      repository.lockInstallation.mock.invocationCallOrder[0],
    ).toBeLessThan(repository.employeeCount.mock.invocationCallOrder[0]);
    expect(repository.insert).toHaveBeenCalledWith(
      input,
      {
        employeeId: result.employeeId,
        divisionId: expect.any(String),
        positionId: expect.any(String),
      },
      manager,
    );
    expect(Object.keys(result)).toEqual(['employeeId']);
  });

  it('never changes an existing installation', async () => {
    repository.employeeCount.mockResolvedValue(1);
    await expect(service().firstHrd(input)).rejects.toThrow(
      'empty employee table',
    );
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it.each(['production', 'test'])(
    'refuses fictional seeding in %s',
    async (environment) => {
      await expect(service(environment).firstHrd(input, true)).rejects.toThrow(
        'development',
      );
      expect(repository.transaction).not.toHaveBeenCalled();
    },
  );

  it('uses explicit fictional identities and an operator supplied password in development', async () => {
    await service('development').firstHrd(input, true);
    expect(repository.insert.mock.calls[0][0]).toEqual({
      initialPassword: input.initialPassword,
      fullName: 'Fictional HRD',
      email: 'fictional-hrd@example.test',
      divisionCode: 'DEMO',
      divisionName: 'Fictional division',
      positionCode: 'DEMO-HRD',
      positionName: 'Fictional HRD position',
    });
  });

  it('propagates write failure to the transaction owner', async () => {
    repository.insert.mockRejectedValueOnce(new Error('write failed'));
    await expect(service().firstHrd(input)).rejects.toThrow('write failed');
  });
});
