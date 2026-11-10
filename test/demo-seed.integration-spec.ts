import { In } from 'typeorm';
import type { DataSource } from 'typeorm';

import {
  DivisionEntity,
  EmployeeEntity,
  PositionEntity,
} from '../src/database/entities';
import { DEMO_DIVISIONS, DEMO_PEOPLE } from '../src/operations/demo-seed.data';
import { DemoSeedRepository } from '../src/operations/demo-seed.repository';
import { DemoSeedService } from '../src/operations/demo-seed.service';
import { loadRuntimeConfig } from '../src/runtime/runtime.config';
import { prepareTestDatabase } from './mysql-fixture';

// Isolated _test schema only; never run this against the developer/production .env.
describe('demo people seed with native MySQL', () => {
  let source: DataSource;
  let service: DemoSeedService;
  let isolated = false;
  const emails = In(DEMO_PEOPLE.map((person) => person.email));
  const divisions = In(DEMO_DIVISIONS.map((division) => division.code));
  const positions = In(
    DEMO_DIVISIONS.map((division) => `${division.code}-STAFF`),
  );

  beforeAll(async () => {
    source = await prepareTestDatabase();
    const repository = new DemoSeedRepository(source);
    const existing = await repository.existing(source.manager);
    if (Object.values(existing).some((rows) => rows.length)) {
      throw new Error('Integration requires no existing demo codes or emails.');
    }
    isolated = true;
    service = new DemoSeedService(repository, loadRuntimeConfig());
  });

  afterEach(async () => {
    if (!isolated) return;
    await source.manager.delete(EmployeeEntity, { email: emails });
    await source.manager.delete(PositionEntity, { code: positions });
    await source.manager.delete(DivisionEntity, { code: divisions });
  });

  afterAll(async () => {
    await source?.destroy();
  });

  it('serializes concurrent seed runs and creates exactly 40 valid accounts', async () => {
    const results = await Promise.all([service.seed(), service.seed()]);
    expect(
      results
        .map((result) => result.created.hr + result.created.employees)
        .sort((a, b) => a - b),
    ).toEqual([0, 40]);
    const accounts = await source.manager.find(EmployeeEntity, {
      where: { email: emails },
      relations: { position: true },
      relationLoadStrategy: 'join',
    });
    expect(accounts).toHaveLength(40);
    expect(accounts.filter((row) => row.role === 'HRD')).toHaveLength(4);
    expect(accounts.filter((row) => row.role === 'EMPLOYEE')).toHaveLength(36);
    expect(
      accounts.every((row) => row.position.divisionId === row.divisionId),
    ).toBe(true);
    expect(
      await source.manager.countBy(DivisionEntity, { code: divisions }),
    ).toBe(6);
    expect(
      await source.manager.countBy(PositionEntity, { code: positions }),
    ).toBe(6);
  });

  it('preserves changed credentials and does not update accounts on rerun', async () => {
    await service.seed();
    const email = DEMO_PEOPLE[0].email;
    await source.manager.update(
      EmployeeEntity,
      { email },
      {
        passwordHash: 'fixture-changed-hash',
        initialPassword: null,
        hasPasswordChanged: true,
      },
    );
    expect((await service.seed('A-different-demo-password')).skipped).toBe(40);
    const [row] = await source.query(
      'SELECT initial_password AS initialPassword, password_hash AS passwordHash, has_password_changed AS changed FROM employees WHERE email = ?',
      [email],
    );
    expect(row).toMatchObject({
      initialPassword: null,
      passwordHash: 'fixture-changed-hash',
      changed: 1,
    });
  });

  it('rolls back all new divisions/positions when the employee batch fails', async () => {
    await source.query(
      "CREATE TRIGGER demo_seed_fail BEFORE INSERT ON employees FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'seed rollback fixture'",
    );
    try {
      await expect(service.seed()).rejects.toThrow();
      expect(
        await source.manager.countBy(EmployeeEntity, { email: emails }),
      ).toBe(0);
      expect(
        await source.manager.countBy(PositionEntity, { code: positions }),
      ).toBe(0);
      expect(
        await source.manager.countBy(DivisionEntity, { code: divisions }),
      ).toBe(0);
    } finally {
      await source.query('DROP TRIGGER demo_seed_fail');
    }
  });
});
