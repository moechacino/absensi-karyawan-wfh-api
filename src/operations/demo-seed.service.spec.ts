import type { EntityManager } from 'typeorm';
import type {
  DivisionEntity,
  EmployeeEntity,
  PositionEntity,
} from '../database/entities';
import type { RuntimeConfig } from '../runtime/runtime.config';
import { DEMO_DIVISIONS, DEMO_PASSWORD, DEMO_PEOPLE } from './demo-seed.data';
import { DemoSeedRepository } from './demo-seed.repository';
import { DemoSeedService } from './demo-seed.service';

function fixture(environment = 'development') {
  const manager = {} as EntityManager;
  const saved = {
    divisions: [] as DivisionEntity[],
    positions: [] as PositionEntity[],
    employees: [] as EmployeeEntity[],
  };
  const repository = {
    transaction: jest.fn(
      async (work: (manager: EntityManager) => Promise<unknown>) =>
        work(manager),
    ),
    lock: jest.fn(),
    existing: jest.fn(async () => saved),
    insert: jest.fn(async (_manager: EntityManager, rows: typeof saved) => {
      saved.divisions.push(...rows.divisions);
      saved.positions.push(...rows.positions);
      saved.employees.push(...rows.employees);
    }),
  };
  const service = new DemoSeedService(
    repository as unknown as DemoSeedRepository,
    { app: { environment } } as RuntimeConfig,
  );

  return { service, saved, repository, manager };
}

describe('demo HR and employee seeding', () => {
  it('creates 4 HRD and 36 employees across 6 divisions with valid matching positions', async () => {
    const f = fixture();
    expect(await f.service.seed()).toEqual({
      total: 40,
      created: { hr: 4, employees: 36, divisions: 6, positions: 6 },
      skipped: 0,
    });
    expect(f.saved.employees.filter((row) => row.role === 'HRD')).toHaveLength(
      4,
    );
    expect(
      f.saved.employees.filter((row) => row.role === 'EMPLOYEE'),
    ).toHaveLength(36);
    expect(new Set(f.saved.employees.map((row) => row.email)).size).toBe(40);

    for (const employee of f.saved.employees) {
      const position = f.saved.positions.find(
        (row) => row.id === employee.positionId,
      )!;
      expect(position.divisionId).toBe(employee.divisionId);
      expect(
        f.saved.divisions.some((row) => row.id === employee.divisionId),
      ).toBe(true);
      expect(employee).toMatchObject({
        status: 'ACTIVE',
        initialPassword: DEMO_PASSWORD,
        passwordHash: null,
        hasPasswordChanged: false,
      });
    }
    expect(f.repository.lock).toHaveBeenCalledWith(f.manager);
    expect(f.repository.insert).toHaveBeenCalledWith(
      f.manager,
      expect.any(Object),
    );
    expect(f.repository.lock.mock.invocationCallOrder[0]).toBeLessThan(
      f.repository.existing.mock.invocationCallOrder[0],
    );
  });

  it('adds data alongside existing accounts and preserves changed credentials/status/roles on rerun', async () => {
    const f = fixture();
    const original = {
      id: 'existing-admin',
      email: 'real-hr@example.test',
      role: 'HRD',
      initialPassword: 'existing',
    } as EmployeeEntity;
    f.saved.employees.push(original);
    await f.service.seed();
    const seeded = f.saved.employees[1];
    Object.assign(seeded, {
      initialPassword: null,
      passwordHash: 'changed-hash',
      hasPasswordChanged: true,
      role: 'EMPLOYEE',
      status: 'INACTIVE',
    });
    const before = structuredClone(f.saved);
    expect(await f.service.seed('Different-demo-password')).toEqual({
      total: 40,
      created: { hr: 0, employees: 0, divisions: 0, positions: 0 },
      skipped: 40,
    });
    expect(f.saved).toEqual(before);
    expect(f.saved.employees[0]).toBe(original);
  });

  it('uses an operator-supplied password only for newly created accounts', async () => {
    const f = fixture('test');
    await f.service.seed('Custom-demo-password');
    expect(
      f.saved.employees.every(
        (row) => row.initialPassword === 'Custom-demo-password',
      ),
    ).toBe(true);
  });

  it('fills only missing records after a partial prior seed', async () => {
    const f = fixture();
    await f.service.seed();
    f.saved.employees.pop();
    expect(await f.service.seed()).toMatchObject({
      created: { hr: 0, employees: 1, divisions: 0, positions: 0 },
      skipped: 39,
    });
    expect(f.saved.employees).toHaveLength(40);
  });

  it('refuses production and invalid passwords before opening a transaction', async () => {
    const production = fixture('production');
    await expect(production.service.seed()).rejects.toThrow(
      'development or test',
    );
    expect(production.repository.transaction).not.toHaveBeenCalled();
    const f = fixture();
    for (const password of ['', 'x'.repeat(7), '😀'.repeat(129)]) {
      await expect(f.service.seed(password)).rejects.toThrow('8–128');
    }
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });

  it.each(['division', 'position', 'email'])(
    'refuses a conflicting demo %s without writing more data',
    async (kind) => {
      const f = fixture();
      await f.service.seed();
      f.repository.insert.mockClear();
      if (kind === 'division') f.saved.divisions[0].status = 'INACTIVE';
      if (kind === 'position')
        f.saved.positions[0].divisionId = 'other-division';
      if (kind === 'email') f.saved.employees[0].positionId = 'other-position';
      await expect(f.service.seed()).rejects.toThrow(
        'no seed data was written',
      );
      expect(f.repository.insert).not.toHaveBeenCalled();
    },
  );

  it('propagates insertion failure to the transaction owner and returns no partial success', async () => {
    const f = fixture();
    f.repository.insert.mockRejectedValueOnce(
      new Error('database write failed'),
    );
    await expect(f.service.seed()).rejects.toThrow('database write failed');
  });

  it('keeps all fixture codes/emails bounded and fictional', () => {
    expect(DEMO_PEOPLE).toHaveLength(40);
    expect(
      DEMO_PEOPLE.every((row) => row.email.endsWith('@example.test')),
    ).toBe(true);
    expect(
      DEMO_DIVISIONS.every(
        (row) => row.code.length <= 40 && (row.code + '-STAFF').length <= 40,
      ),
    ).toBe(true);
  });
});
