import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { createDataSource } from '../src/database/data-source';
import {
  connectDatabase,
  dataSourceOptions,
} from '../src/database/database.options';
import { loadRuntimeConfig } from '../src/runtime/runtime.config';
import { InitialSchema1794096000001 } from '../src/database/migrations/1794096000001-initial-schema';
import {
  DATABASE_ENTITIES,
  DivisionEntity,
  PositionEntity,
  EmployeeEntity,
  AttendanceEntity,
  ScheduleEventEntity,
  ScheduleVersionEntity,
  IdempotencyOperationEntity,
  FileObjectEntity,
  HolidayCalendarEntity,
  HolidayEntity,
} from '../src/database/entities';
import { insertFixture, prepareTestDatabase } from './mysql-fixture';

describe('explicit MySQL schema and persistence invariants', () => {
  let source: DataSource;
  beforeAll(async () => {
    source = await prepareTestDatabase();
  });
  afterAll(async () => {
    await source?.destroy();
  });

  it('reverts an empty baseline, connects without schema checks or writes, and reapplies once', async () => {
    await source.undoLastMigration();
    const before = await source.query('SHOW TABLES');
    expect(await source.showMigrations()).toBe(true);
    const connection = await connectDatabase(
      dataSourceOptions(loadRuntimeConfig()),
    );
    await connection.destroy();
    expect(await source.query('SHOW TABLES')).toEqual(before);
    expect(
      (await source.runMigrations()).map((migration) => migration.name),
    ).toEqual(['InitialSchema1794096000001']);
    expect(
      (await source.runMigrations()).map((migration) => migration.name),
    ).toEqual([]);
    expect(await source.showMigrations()).toBe(false);
  });

  it('maps every entity column/index/foreign key to real InnoDB tables with binary UUIDs and native CHECKs', async () => {
    const runner = source.createQueryRunner();
    try {
      for (const entity of DATABASE_ENTITIES) {
        const metadata = source.getMetadata(entity);
        const table = await runner.getTable(metadata.tableName);
        expect(table).toBeDefined();
        expect(table!.columns.map((column) => column.name).sort()).toEqual(
          metadata.columns.map((column) => column.databaseName).sort(),
        );
        for (const index of metadata.indices)
          expect(
            table!.indices.some(
              (actual) =>
                actual.name === index.name &&
                actual.isUnique === index.isUnique,
            ),
          ).toBe(true);
        for (const foreign of metadata.foreignKeys)
          expect(
            table!.foreignKeys.some(
              (actual) =>
                actual.name === foreign.name && actual.onDelete === 'RESTRICT',
            ),
          ).toBe(true);
      }
      const tables: { name: string; engine: string }[] = await source.query(
        'SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
      );
      expect(
        tables.every((table: { engine: string }) => table.engine === 'InnoDB'),
      ).toBe(true);
      const applicationTables = tables
        .map((table) => table.name)
        .filter(
          (name) => !['schema_migrations', 'typeorm_metadata'].includes(name),
        );
      expect(applicationTables).toHaveLength(11);
      for (const deferred of [
        'time_off_types',
        'time_off_requests',
        'request_calculations',
        'request_working_dates',
        'annual_balances',
        'balance_entries',
        'reconciliations',
        'employee_credentials',
        'audit_events',
        'display_code_counters',
        'business_tokens',
        'hr_administration_guard',
        'revoked_access_tokens',
        'upload_attempts',
        'storage_cleanup_jobs',
      ])
        expect(applicationTables).not.toContain(deferred);
      const checks = await source.query(
        "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'CHECK'",
      );
      expect(checks).toHaveLength(15);
      const triggers = await source.query(
        'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()',
      );
      expect(triggers).toHaveLength(2);
      expect(
        await source.query(
          "SELECT name FROM typeorm_metadata WHERE type = 'GENERATED_COLUMN' AND `schema` = DATABASE()",
        ),
      ).toHaveLength(1);
      const [column] = await source.query(
        "SELECT COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'id'",
      );
      expect(column.collation).toBe('ascii_bin');
      const [ddl] = await source.query('SHOW CREATE TABLE employees');
      expect(ddl['Create Table']).toContain('ck_employee_credentials');
      expect(
        (await source.driver.createSchemaBuilder().log()).upQueries,
      ).toEqual([]);
    } finally {
      await runner.release();
    }
  });

  it('rejects earlier draft migration history without overwriting existing rows or schema', async () => {
    const id = randomUUID();
    await source.manager.insert(DivisionEntity, {
      id,
      code: id.slice(0, 8),
      name: 'Preserved earlier-draft fixture',
    });
    const before = await source.query('SHOW TABLES');
    try {
      await source.query(
        'UPDATE schema_migrations SET name = ?, timestamp = ? WHERE name = ?',
        [
          'InitialSchema1794042000000',
          1794042000000,
          'InitialSchema1794096000001',
        ],
      );
      await expect(source.runMigrations()).rejects.toThrow(
        'requires an empty database',
      );
      expect(await source.query('SHOW TABLES')).toEqual(before);
      expect(
        (await source.manager.findOneByOrFail(DivisionEntity, { id })).name,
      ).toBe('Preserved earlier-draft fixture');
    } finally {
      await source.query(
        'UPDATE schema_migrations SET name = ?, timestamp = ? WHERE name = ?',
        [
          'InitialSchema1794096000001',
          1794096000001,
          'InitialSchema1794042000000',
        ],
      );
      await source.manager.delete(DivisionEntity, { id });
    }
  });

  it('refuses dirty-schema initialization and populated-schema rollback without deleting anything', async () => {
    const id = randomUUID();
    await source.manager.insert(DivisionEntity, {
      id,
      code: id.slice(0, 8),
      name: 'Preserve this row',
    });
    try {
      const runner = source.createQueryRunner();
      try {
        await expect(
          new InitialSchema1794096000001().up(runner),
        ).rejects.toThrow('requires an empty database');
      } finally {
        await runner.release();
      }
      await expect(source.undoLastMigration()).rejects.toThrow(
        'Refusing to revert a used schema',
      );
      expect(
        await source.getRepository(DivisionEntity).findOneBy({ id }),
      ).not.toBeNull();
      expect(await source.query('SELECT name FROM schema_migrations')).toEqual([
        { name: 'InitialSchema1794096000001' },
      ]);
    } finally {
      await source.manager.delete(DivisionEntity, { id });
    }
  });

  it('runs standard TypeORM migrations with a one-connection pool', async () => {
    const config = loadRuntimeConfig();
    const single = createDataSource({
      ...config,
      database: { ...config.database, poolSize: 1 },
    });
    await single.initialize();
    try {
      expect(await single.runMigrations()).toEqual([]);
    } finally {
      await single.destroy();
    }
  });

  describe('transactional row constraints', () => {
    let runner: QueryRunner;
    let manager: EntityManager;
    let ids: Awaited<ReturnType<typeof insertFixture>>;
    beforeEach(async () => {
      runner = source.createQueryRunner();
      await runner.connect();
      await runner.startTransaction('READ COMMITTED');
      manager = runner.manager;
      ids = await insertFixture(manager);
    });
    afterEach(async () => {
      if (runner?.isTransactionActive) await runner.rollbackTransaction();
      await runner?.release();
    });

    it('deduplicates normalized emails and validates compatible position/division references', async () => {
      const original = await manager.findOneByOrFail(EmployeeEntity, {
        id: ids.employee,
      });
      await expect(
        manager.update(
          EmployeeEntity,
          { id: ids.otherEmployee },
          { email: ' ' + original.email.toUpperCase() + ' ' },
        ),
      ).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } });
      const normalizedInput = randomUUID() + '@example.test';
      await manager.update(
        EmployeeEntity,
        { id: ids.otherEmployee },
        { email: ' ' + normalizedInput.toUpperCase() + ' ' },
      );
      expect(
        (
          await manager.findOneByOrFail(EmployeeEntity, {
            email: ' ' + normalizedInput.toUpperCase() + ' ',
          })
        ).email,
      ).toBe(normalizedInput);
      const otherDivision = randomUUID();
      await manager.insert(DivisionEntity, {
        id: otherDivision,
        code: otherDivision.slice(0, 8),
        name: 'Other division',
      });
      await expect(
        manager.update(
          EmployeeEntity,
          { id: ids.employee },
          { divisionId: otherDivision },
        ),
      ).rejects.toMatchObject({
        driverError: { code: 'ER_NO_REFERENCED_ROW_2' },
      });
      await expect(
        manager.delete(PositionEntity, { id: ids.position }),
      ).rejects.toMatchObject({
        driverError: { code: 'ER_ROW_IS_REFERENCED_2' },
      });
    });

    it('excludes credential values from normal reads and enforces atomic plaintext-to-hash state', async () => {
      const credential = await manager.findOneByOrFail(EmployeeEntity, {
        id: ids.employee,
      });
      expect(credential.initialPassword).toBeUndefined();
      expect(credential.passwordHash).toBeUndefined();
      expect(credential.hasPasswordChanged).toBe(false);
      await expect(
        manager.update(
          EmployeeEntity,
          { id: ids.employee },
          { hasPasswordChanged: true },
        ),
      ).rejects.toMatchObject({
        driverError: { code: 'ER_CHECK_CONSTRAINT_VIOLATED' },
      });
      await expect(
        manager.update(
          EmployeeEntity,
          { id: ids.employee },
          { passwordHash: 'fictional-hash' },
        ),
      ).rejects.toMatchObject({
        driverError: { code: 'ER_CHECK_CONSTRAINT_VIOLATED' },
      });
      await manager.update(
        EmployeeEntity,
        { id: ids.employee },
        {
          initialPassword: null,
          passwordHash: 'fictional-hash',
          hasPasswordChanged: true,
        },
      );
      const changed = await manager
        .getRepository(EmployeeEntity)
        .createQueryBuilder('credential')
        .addSelect(['credential.initialPassword', 'credential.passwordHash'])
        .where('credential.id = :id', { id: ids.employee })
        .getOneOrFail();
      expect(changed.initialPassword).toBeNull();
      expect(changed.passwordHash).toBe('fictional-hash');
      expect(changed.hasPasswordChanged).toBe(true);
    });

    function attendance(date: string, closed: boolean) {
      return {
        id: randomUUID(),
        employeeId: ids.employee,
        workDate: date,
        scheduleVersionId: ids.schedule,
        timeZone: 'Asia/Jakarta',
        plannedStartAt: new Date(date + 'T01:00:00.000Z'),
        plannedEndAt: new Date(date + 'T09:00:00.000Z'),
        checkInAt: new Date(date + 'T01:00:00.123Z'),
        checkOutAt: closed ? new Date(date + 'T09:00:00.123Z') : null,
        punctuality: 'LATE' as const,
        lateSeconds: 1,
        durationSeconds: closed ? 28800 : null,
        photoFileId: ids.file,
      };
    }

    it('enforces one attendance per date and one open record, allowing multiple closed records', async () => {
      await manager.insert(AttendanceEntity, attendance('2026-11-07', true));
      await expect(
        manager.insert(AttendanceEntity, attendance('2026-11-07', true)),
      ).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } });
      const open = attendance('2026-11-08', false);
      await manager.insert(AttendanceEntity, open);
      await expect(
        manager.insert(AttendanceEntity, attendance('2026-11-09', false)),
      ).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } });
      await manager.update(
        AttendanceEntity,
        { id: open.id },
        {
          checkOutAt: new Date('2026-11-08T09:00:00.123Z'),
          durationSeconds: 28800,
        },
      );
      await manager.insert(AttendanceEntity, attendance('2026-11-09', false));
      expect(await manager.count(AttendanceEntity)).toBe(3);
    });

    it('preserves attendance/holiday date strings and UTC millisecond precision', async () => {
      const row = attendance('2026-11-16', true);
      await manager.insert(AttendanceEntity, row);
      const actual = await manager.findOneByOrFail(AttendanceEntity, {
        id: row.id,
      });
      expect(actual.workDate).toBe('2026-11-16');
      expect(actual.checkInAt.toISOString()).toBe('2026-11-16T01:00:00.123Z');
      await manager.insert(HolidayCalendarEntity, { year: 2026 });
      await manager.insert(HolidayEntity, {
        year: 2026,
        date: '2026-12-25',
        name: 'Fixture holiday',
        category: 'PUBLIC',
      });
      expect(
        (
          await manager.findOneByOrFail(HolidayEntity, {
            year: 2026,
            date: '2026-12-25',
          })
        ).date,
      ).toBe('2026-12-25');
      await expect(
        manager.insert(HolidayEntity, {
          year: 2026,
          date: '2027-01-01',
          name: 'Wrong year',
          category: 'PUBLIC',
        }),
      ).rejects.toMatchObject({
        driverError: { code: 'ER_CHECK_CONSTRAINT_VIOLATED' },
      });
    });

    it('checks active schedule and idempotency row shapes', async () => {
      await expect(
        manager.update(
          ScheduleVersionEntity,
          { id: ids.schedule },
          { workingDays: [1, 1] },
        ),
      ).rejects.toMatchObject({
        driverError: { code: 'ER_CHECK_CONSTRAINT_VIOLATED' },
      });
      await expect(
        manager.insert(IdempotencyOperationEntity, {
          id: randomUUID(),
          actorId: ids.employee,
          routeScope: 'createEmployee',
          idempotencyKey: randomUUID(),
          fingerprint: 'a'.repeat(64),
          state: 'COMPLETED',
          result: {},
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
        }),
      ).rejects.toMatchObject({
        driverError: { code: 'ER_CHECK_CONSTRAINT_VIOLATED' },
      });
      const operation = {
        id: randomUUID(),
        actorId: ids.employee,
        routeScope: 'createEmployee',
        idempotencyKey: randomUUID(),
        fingerprint: 'b'.repeat(64),
        state: 'COMPLETED' as const,
        httpStatus: 201,
        result: {},
        completedAt: new Date('2026-11-16T00:00:00Z'),
        expiresAt: new Date('2026-11-17T00:00:00Z'),
      };
      await manager.insert(IdempotencyOperationEntity, operation);
      await expect(
        manager.insert(IdempotencyOperationEntity, {
          ...operation,
          id: randomUUID(),
        }),
      ).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } });
      await manager.insert(IdempotencyOperationEntity, {
        ...operation,
        id: randomUUID(),
        actorId: ids.otherEmployee,
      });
    });

    it('keeps schedule history append-only', async () => {
      const event = {
        id: randomUUID(),
        scheduleVersionId: ids.schedule,
        actorId: ids.employee,
        kind: 'SAVED' as const,
        calendarVersion: 1,
        details: {},
      };
      await manager.insert(ScheduleEventEntity, event);
      for (const [table, id] of [['schedule_events', event.id]]) {
        await expect(
          manager.query('UPDATE `' + table + '` SET id = id WHERE id = ?', [
            id,
          ]),
        ).rejects.toMatchObject({
          driverError: { code: 'ER_SIGNAL_EXCEPTION' },
        });
        await expect(
          manager.query('DELETE FROM `' + table + '` WHERE id = ?', [id]),
        ).rejects.toMatchObject({
          driverError: { code: 'ER_SIGNAL_EXCEPTION' },
        });
      }
    });

    it('restricts file metadata to check-in/profile image purposes', async () => {
      for (const [column, value] of [
        ['mime_type', 'application/pdf'],
        ['purpose', 'TIME_OFF_ATTACHMENT'],
      ]) {
        await expect(
          manager.query(
            'UPDATE file_objects SET `' + column + '` = ? WHERE id = ?',
            [value, ids.file],
          ),
        ).rejects.toMatchObject({
          driverError: { code: 'WARN_DATA_TRUNCATED' },
        });
      }
      expect(
        (await manager.findOneByOrFail(FileObjectEntity, { id: ids.file }))
          .mimeType,
      ).toBe('image/jpeg');
    });
  });
});
