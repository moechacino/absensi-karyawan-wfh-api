import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1794096000001 implements MigrationInterface {
  name = 'InitialSchema1794096000001';
  readonly transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ database }]: { database: string }[] = await queryRunner.query(
      'SELECT DATABASE() AS `database`',
    );
    const existing: unknown[] = await queryRunner.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT IN ('schema_migrations', 'typeorm_metadata')",
    );
    if (existing.length)
      throw new Error(
        'Initial migration requires an empty database; preserve existing data and use a reviewed forward migration for an older baseline or partial schema.',
      );

    await queryRunner.query(`
            CREATE TABLE \`divisions\` (
                \`id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`created_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                \`code\` varchar(32) NOT NULL,
                \`name\` varchar(160) NOT NULL,
                \`description\` varchar(2000) NULL,
                \`status\` enum ('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
                \`version\` int UNSIGNED NOT NULL DEFAULT '1',
                \`updated_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
                UNIQUE INDEX \`uq_division_code\` (\`code\`),
                PRIMARY KEY (\`id\`)
            ) ENGINE = InnoDB
        `);
    await queryRunner.query(`
            CREATE TABLE \`positions\` (
                \`id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`created_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                \`division_id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`code\` varchar(32) NOT NULL,
                \`name\` varchar(160) NOT NULL,
                \`status\` enum ('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
                \`version\` int UNSIGNED NOT NULL DEFAULT '1',
                \`updated_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
                UNIQUE INDEX \`uq_position_division\` (\`id\`, \`division_id\`),
                UNIQUE INDEX \`uq_position_code\` (\`code\`),
                PRIMARY KEY (\`id\`)
            ) ENGINE = InnoDB
        `);
    await queryRunner.query(`
            CREATE TABLE \`employees\` (
                \`id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`created_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                \`full_name\` varchar(160) NOT NULL,
                \`email\` varchar(254) COLLATE "utf8mb4_bin" NOT NULL,
                \`division_id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`position_id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`role\` enum ('EMPLOYEE', 'HRD') NOT NULL DEFAULT 'EMPLOYEE',
                \`status\` enum ('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
                \`photo_file_id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NULL,
                \`version\` int UNSIGNED NOT NULL DEFAULT '1',
                \`updated_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
                \`has_password_changed\` tinyint NOT NULL DEFAULT 0,
                \`initial_password\` varchar(128) NULL,
                \`password_hash\` varchar(255) NULL,
                INDEX \`ix_employee_role_status\` (\`role\`, \`status\`, \`id\`),
                INDEX \`ix_employee_name\` (\`full_name\`, \`id\`),
                UNIQUE INDEX \`uq_employee_email\` (\`email\`),
                PRIMARY KEY (\`id\`)
            ) ENGINE = InnoDB
        `);
    await queryRunner.query(`
            CREATE TABLE \`file_objects\` (
                \`id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`created_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                \`owner_employee_id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`object_key\` varchar(512) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`file_name\` varchar(255) NOT NULL,
                \`mime_type\` enum ('image/jpeg', 'image/png', 'image/webp') NOT NULL,
                \`size_bytes\` int NOT NULL,
                \`sha256\` varchar(64) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`purpose\` enum ('CHECK_IN_PHOTO', 'EMPLOYEE_PROFILE_PHOTO') NOT NULL,
                \`state\` enum ('STAGED', 'ATTACHED', 'RETIRED') NOT NULL DEFAULT 'STAGED',
                INDEX \`ix_file_owner\` (\`owner_employee_id\`, \`purpose\`, \`created_at\`),
                UNIQUE INDEX \`uq_file_key\` (\`object_key\`),
                PRIMARY KEY (\`id\`)
            ) ENGINE = InnoDB
        `);
    await queryRunner.query(`
            CREATE TABLE \`calendar_state\` (
                \`id\` tinyint UNSIGNED NOT NULL,
                \`version\` int UNSIGNED NOT NULL DEFAULT '0',
                PRIMARY KEY (\`id\`)
            ) ENGINE = InnoDB
        `);
    await queryRunner.query(`
            CREATE TABLE \`schedule_versions\` (
                \`id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`created_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                \`working_days\` json NOT NULL,
                \`start_time\` varchar(5) NOT NULL,
                \`end_time\` varchar(5) NOT NULL,
                \`end_day_offset\` tinyint UNSIGNED NOT NULL DEFAULT '0',
                \`time_zone\` varchar(100) NOT NULL,
                \`effective_from\` date NOT NULL,
                \`effective_at\` datetime(3) NOT NULL,
                \`superseded_at\` datetime(3) NULL,
                \`created_by\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                INDEX \`ix_schedule_effective\` (\`effective_at\`, \`id\`),
                PRIMARY KEY (\`id\`)
            ) ENGINE = InnoDB
        `);
    await queryRunner.query(`
            CREATE TABLE \`schedule_events\` (
                \`id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`created_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                \`schedule_version_id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`actor_id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`kind\` enum ('SAVED', 'SUPERSEDED') NOT NULL,
                \`calendar_version\` int UNSIGNED NOT NULL,
                \`details\` json NOT NULL,
                INDEX \`ix_schedule_event_time\` (\`created_at\`, \`id\`),
                PRIMARY KEY (\`id\`)
            ) ENGINE = InnoDB
        `);
    await queryRunner.query(`
            CREATE TABLE \`holiday_calendars\` (
                \`year\` smallint UNSIGNED NOT NULL,
                \`version\` int UNSIGNED NOT NULL DEFAULT '1',
                PRIMARY KEY (\`year\`)
            ) ENGINE = InnoDB
        `);
    await queryRunner.query(`
            CREATE TABLE \`holidays\` (
                \`year\` smallint UNSIGNED NOT NULL,
                \`date\` date NOT NULL,
                \`name\` varchar(160) NOT NULL,
                \`category\` enum ('COMPANY', 'PUBLIC', 'OTHER') NOT NULL,
                PRIMARY KEY (\`year\`, \`date\`)
            ) ENGINE = InnoDB
        `);
    await queryRunner.query(`
            CREATE TABLE \`idempotency_operations\` (
                \`id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`created_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                \`actor_id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`route_scope\` varchar(200) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`idempotency_key\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`fingerprint\` varchar(64) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`state\` enum ('IN_PROGRESS', 'COMPLETED') NOT NULL DEFAULT 'IN_PROGRESS',
                \`lease_owner\` varchar(64) CHARACTER SET "ascii" COLLATE "ascii_bin" NULL,
                \`lease_expires_at\` datetime(3) NULL,
                \`http_status\` smallint UNSIGNED NULL,
                \`result\` json NULL,
                \`resource_id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NULL,
                \`completed_at\` datetime(3) NULL,
                \`expires_at\` datetime(3) NOT NULL,
                INDEX \`ix_idempotency_expiry\` (\`expires_at\`),
                UNIQUE INDEX \`uq_idempotency_scope\` (\`actor_id\`, \`route_scope\`, \`idempotency_key\`),
                PRIMARY KEY (\`id\`)
            ) ENGINE = InnoDB
        `);
    await queryRunner.query(`
            CREATE TABLE \`attendances\` (
                \`id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`created_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                \`employee_id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`work_date\` date NOT NULL,
                \`schedule_version_id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`time_zone\` varchar(100) NOT NULL,
                \`planned_start_at\` datetime(3) NOT NULL,
                \`planned_end_at\` datetime(3) NOT NULL,
                \`check_in_at\` datetime(3) NOT NULL,
                \`check_out_at\` datetime(3) NULL,
                \`punctuality\` enum ('ON_TIME', 'LATE') NOT NULL,
                \`late_seconds\` int NOT NULL DEFAULT '0',
                \`duration_seconds\` int NULL,
                \`photo_file_id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" NOT NULL,
                \`open_employee_id\` char(36) CHARACTER SET "ascii" COLLATE "ascii_bin" AS (
                    CASE
                        WHEN \`check_out_at\` IS NULL THEN \`employee_id\`
                        ELSE NULL
                    END
                ) STORED NULL,
                \`version\` int UNSIGNED NOT NULL DEFAULT '1',
                \`updated_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
                INDEX \`ix_attendance_date\` (\`work_date\`, \`employee_id\`),
                UNIQUE INDEX \`uq_attendance_open\` (\`open_employee_id\`),
                UNIQUE INDEX \`uq_attendance_day\` (\`employee_id\`, \`work_date\`),
                PRIMARY KEY (\`id\`)
            ) ENGINE = InnoDB
        `);
    await queryRunner.query(
      `
            INSERT INTO \`typeorm_metadata\`(
                    \`database\`,
                    \`schema\`,
                    \`table\`,
                    \`type\`,
                    \`name\`,
                    \`value\`
                )
            VALUES (DEFAULT, ?, ?, ?, ?, ?)
        `,
      [
        database,
        'attendances',
        'GENERATED_COLUMN',
        'open_employee_id',
        'CASE WHEN `check_out_at` IS NULL THEN `employee_id` ELSE NULL END',
      ],
    );
    await queryRunner.query(`
            ALTER TABLE \`positions\`
            ADD CONSTRAINT \`fk_position_division\` FOREIGN KEY (\`division_id\`) REFERENCES \`divisions\`(\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
        `);
    await queryRunner.query(`
            ALTER TABLE \`employees\`
            ADD CONSTRAINT \`fk_employee_photo\` FOREIGN KEY (\`photo_file_id\`) REFERENCES \`file_objects\`(\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
        `);
    await queryRunner.query(`
            ALTER TABLE \`employees\`
            ADD CONSTRAINT \`fk_employee_position\` FOREIGN KEY (\`position_id\`, \`division_id\`) REFERENCES \`positions\`(\`id\`, \`division_id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
        `);
    await queryRunner.query(`
            ALTER TABLE \`employees\`
            ADD CONSTRAINT \`fk_employee_division\` FOREIGN KEY (\`division_id\`) REFERENCES \`divisions\`(\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
        `);
    await queryRunner.query(`
            ALTER TABLE \`file_objects\`
            ADD CONSTRAINT \`fk_file_owner\` FOREIGN KEY (\`owner_employee_id\`) REFERENCES \`employees\`(\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
        `);
    await queryRunner.query(`
            ALTER TABLE \`schedule_versions\`
            ADD CONSTRAINT \`fk_schedule_actor\` FOREIGN KEY (\`created_by\`) REFERENCES \`employees\`(\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
        `);
    await queryRunner.query(`
            ALTER TABLE \`schedule_events\`
            ADD CONSTRAINT \`fk_schedule_event_actor\` FOREIGN KEY (\`actor_id\`) REFERENCES \`employees\`(\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
        `);
    await queryRunner.query(`
            ALTER TABLE \`schedule_events\`
            ADD CONSTRAINT \`fk_schedule_event_version\` FOREIGN KEY (\`schedule_version_id\`) REFERENCES \`schedule_versions\`(\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
        `);
    await queryRunner.query(`
            ALTER TABLE \`holidays\`
            ADD CONSTRAINT \`fk_holiday_calendar\` FOREIGN KEY (\`year\`) REFERENCES \`holiday_calendars\`(\`year\`) ON DELETE RESTRICT ON UPDATE RESTRICT
        `);
    await queryRunner.query(`
            ALTER TABLE \`idempotency_operations\`
            ADD CONSTRAINT \`fk_idempotency_actor\` FOREIGN KEY (\`actor_id\`) REFERENCES \`employees\`(\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
        `);
    await queryRunner.query(`
            ALTER TABLE \`attendances\`
            ADD CONSTRAINT \`fk_attendance_photo\` FOREIGN KEY (\`photo_file_id\`) REFERENCES \`file_objects\`(\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
        `);
    await queryRunner.query(`
            ALTER TABLE \`attendances\`
            ADD CONSTRAINT \`fk_attendance_schedule\` FOREIGN KEY (\`schedule_version_id\`) REFERENCES \`schedule_versions\`(\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
        `);
    await queryRunner.query(`
            ALTER TABLE \`attendances\`
            ADD CONSTRAINT \`fk_attendance_employee\` FOREIGN KEY (\`employee_id\`) REFERENCES \`employees\`(\`id\`) ON DELETE RESTRICT ON UPDATE RESTRICT
        `);
    // Reviewed MySQL CHECKs/triggers and calendar seed (not generated by TypeORM).
    await queryRunner.query(
      'ALTER TABLE `employees` ADD CONSTRAINT `ck_employee_email` CHECK (CHAR_LENGTH(`email`) > 0 AND BINARY `email` = BINARY LOWER(TRIM(`email`)))',
    );
    await queryRunner.query(
      'ALTER TABLE `employees` ADD CONSTRAINT `ck_employee_credentials` CHECK ((`has_password_changed` = 0 AND `initial_password` IS NOT NULL AND CHAR_LENGTH(`initial_password`) > 0 AND `password_hash` IS NULL) OR (`has_password_changed` = 1 AND `initial_password` IS NULL AND `password_hash` IS NOT NULL AND CHAR_LENGTH(`password_hash`) > 0))',
    );
    await queryRunner.query(
      'ALTER TABLE `file_objects` ADD CONSTRAINT `ck_file_size` CHECK (`size_bytes` BETWEEN 1 AND 5242880)',
    );
    await queryRunner.query(
      'ALTER TABLE `file_objects` ADD CONSTRAINT `ck_file_digest` CHECK (CHAR_LENGTH(`sha256`) = 64)',
    );
    await queryRunner.query(
      'ALTER TABLE `calendar_state` ADD CONSTRAINT `ck_calendar_state_singleton` CHECK (`id` = 1)',
    );
    await queryRunner.query(
      'ALTER TABLE `schedule_versions` ADD CONSTRAINT `ck_schedule_days` CHECK (JSON_SCHEMA_VALID(\'{"type":"array","items":{"type":"integer","minimum":1,"maximum":7},"minItems":1,"maxItems":7,"uniqueItems":true}\', `working_days`))',
    );
    await queryRunner.query(
      "ALTER TABLE `schedule_versions` ADD CONSTRAINT `ck_schedule_times` CHECK (`start_time` REGEXP '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND `end_time` REGEXP '^([01][0-9]|2[0-3]):[0-5][0-9]$')",
    );
    await queryRunner.query(
      'ALTER TABLE `schedule_versions` ADD CONSTRAINT `ck_schedule_offset` CHECK (`end_day_offset` IN (0, 1))',
    );
    await queryRunner.query(
      'ALTER TABLE `schedule_versions` ADD CONSTRAINT `ck_schedule_duration` CHECK ((`end_day_offset` * 86400 + TIME_TO_SEC(`end_time`) - TIME_TO_SEC(`start_time`)) > 0 AND (`end_day_offset` * 86400 + TIME_TO_SEC(`end_time`) - TIME_TO_SEC(`start_time`)) < 86400)',
    );
    await queryRunner.query(
      'ALTER TABLE `holiday_calendars` ADD CONSTRAINT `ck_holiday_year` CHECK (`year` BETWEEN 1970 AND 9999)',
    );
    await queryRunner.query(
      'ALTER TABLE `holidays` ADD CONSTRAINT `ck_holiday_date` CHECK (YEAR(`date`) = `year`)',
    );
    await queryRunner.query(
      'ALTER TABLE `attendances` ADD CONSTRAINT `ck_attendance_interval` CHECK (`planned_end_at` > `planned_start_at`)',
    );
    await queryRunner.query(
      'ALTER TABLE `attendances` ADD CONSTRAINT `ck_attendance_checkout` CHECK ((`check_out_at` IS NULL AND `duration_seconds` IS NULL) OR (`check_out_at` IS NOT NULL AND `check_out_at` >= `check_in_at` AND `duration_seconds` IS NOT NULL AND `duration_seconds` >= 0))',
    );
    await queryRunner.query(
      "ALTER TABLE `attendances` ADD CONSTRAINT `ck_attendance_punctuality` CHECK ((`punctuality` = 'ON_TIME' AND `late_seconds` = 0) OR (`punctuality` = 'LATE' AND `late_seconds` > 0))",
    );
    await queryRunner.query(
      "ALTER TABLE `idempotency_operations` ADD CONSTRAINT `ck_idempotency_state` CHECK ((`state` = 'IN_PROGRESS' AND `lease_owner` IS NOT NULL AND `lease_expires_at` IS NOT NULL AND `http_status` IS NULL AND `result` IS NULL AND `completed_at` IS NULL) OR (`state` = 'COMPLETED' AND `http_status` IS NOT NULL AND `http_status` BETWEEN 100 AND 599 AND `result` IS NOT NULL AND `completed_at` IS NOT NULL AND `lease_owner` IS NULL AND `lease_expires_at` IS NULL))",
    );
    await queryRunner.query(
      "CREATE TRIGGER `deny_schedule_events_update` BEFORE UPDATE ON `schedule_events` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Append-only history cannot be changed'",
    );
    await queryRunner.query(
      "CREATE TRIGGER `deny_schedule_events_delete` BEFORE DELETE ON `schedule_events` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Append-only history cannot be changed'",
    );
    await queryRunner.query(
      'INSERT INTO `calendar_state` (`id`, `version`) VALUES (1, 0)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ database }]: { database: string }[] = await queryRunner.query(
      'SELECT DATABASE() AS `database`',
    );
    const expectedTables = [
      'divisions',
      'positions',
      'employees',
      'file_objects',
      'calendar_state',
      'schedule_versions',
      'schedule_events',
      'holiday_calendars',
      'holidays',
      'attendances',
      'idempotency_operations',
    ];
    const tables: { name: string }[] = await queryRunner.query(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT IN ('schema_migrations', 'typeorm_metadata')",
    );
    if (
      tables.length !== expectedTables.length ||
      tables.some((table) => !expectedTables.includes(table.name))
    )
      throw new Error(
        'Refusing to revert an unexpected schema; preserve data and inspect it first.',
      );
    for (const table of expectedTables.filter(
      (table) => table !== 'calendar_state',
    )) {
      if (
        (await queryRunner.query('SELECT 1 FROM `' + table + '` LIMIT 1'))
          .length
      )
        throw new Error(
          'Refusing to revert a used schema; use a reviewed forward migration or restore a backup.',
        );
    }
    if (
      (
        await queryRunner.query(
          'SELECT 1 FROM calendar_state WHERE id <> 1 OR version <> 0 LIMIT 1',
        )
      ).length
    )
      throw new Error(
        'Refusing to revert a used schema; use a reviewed forward migration or restore a backup.',
      );

    await queryRunner.query(`
            ALTER TABLE \`attendances\` DROP FOREIGN KEY \`fk_attendance_employee\`
        `);
    await queryRunner.query(`
            ALTER TABLE \`attendances\` DROP FOREIGN KEY \`fk_attendance_schedule\`
        `);
    await queryRunner.query(`
            ALTER TABLE \`attendances\` DROP FOREIGN KEY \`fk_attendance_photo\`
        `);
    await queryRunner.query(`
            ALTER TABLE \`idempotency_operations\` DROP FOREIGN KEY \`fk_idempotency_actor\`
        `);
    await queryRunner.query(`
            ALTER TABLE \`holidays\` DROP FOREIGN KEY \`fk_holiday_calendar\`
        `);
    await queryRunner.query(`
            ALTER TABLE \`schedule_events\` DROP FOREIGN KEY \`fk_schedule_event_version\`
        `);
    await queryRunner.query(`
            ALTER TABLE \`schedule_events\` DROP FOREIGN KEY \`fk_schedule_event_actor\`
        `);
    await queryRunner.query(`
            ALTER TABLE \`schedule_versions\` DROP FOREIGN KEY \`fk_schedule_actor\`
        `);
    await queryRunner.query(`
            ALTER TABLE \`file_objects\` DROP FOREIGN KEY \`fk_file_owner\`
        `);
    await queryRunner.query(`
            ALTER TABLE \`employees\` DROP FOREIGN KEY \`fk_employee_division\`
        `);
    await queryRunner.query(`
            ALTER TABLE \`employees\` DROP FOREIGN KEY \`fk_employee_position\`
        `);
    await queryRunner.query(`
            ALTER TABLE \`employees\` DROP FOREIGN KEY \`fk_employee_photo\`
        `);
    await queryRunner.query(`
            ALTER TABLE \`positions\` DROP FOREIGN KEY \`fk_position_division\`
        `);
    await queryRunner.query(
      `
            DELETE FROM \`typeorm_metadata\`
            WHERE \`type\` = ?
                AND \`name\` = ?
                AND \`schema\` = ?
                AND \`table\` = ?
        `,
      ['GENERATED_COLUMN', 'open_employee_id', database, 'attendances'],
    );
    await queryRunner.query(`
            DROP INDEX \`uq_attendance_day\` ON \`attendances\`
        `);
    await queryRunner.query(`
            DROP INDEX \`uq_attendance_open\` ON \`attendances\`
        `);
    await queryRunner.query(`
            DROP INDEX \`ix_attendance_date\` ON \`attendances\`
        `);
    await queryRunner.query(`
            DROP TABLE \`attendances\`
        `);
    await queryRunner.query(`
            DROP INDEX \`uq_idempotency_scope\` ON \`idempotency_operations\`
        `);
    await queryRunner.query(`
            DROP INDEX \`ix_idempotency_expiry\` ON \`idempotency_operations\`
        `);
    await queryRunner.query(`
            DROP TABLE \`idempotency_operations\`
        `);
    await queryRunner.query(`
            DROP TABLE \`holidays\`
        `);
    await queryRunner.query(`
            DROP TABLE \`holiday_calendars\`
        `);
    await queryRunner.query(`
            DROP INDEX \`ix_schedule_event_time\` ON \`schedule_events\`
        `);
    await queryRunner.query(`
            DROP TABLE \`schedule_events\`
        `);
    await queryRunner.query(`
            DROP INDEX \`ix_schedule_effective\` ON \`schedule_versions\`
        `);
    await queryRunner.query(`
            DROP TABLE \`schedule_versions\`
        `);
    await queryRunner.query(`
            DROP TABLE \`calendar_state\`
        `);
    await queryRunner.query(`
            DROP INDEX \`uq_file_key\` ON \`file_objects\`
        `);
    await queryRunner.query(`
            DROP INDEX \`ix_file_owner\` ON \`file_objects\`
        `);
    await queryRunner.query(`
            DROP TABLE \`file_objects\`
        `);
    await queryRunner.query(`
            DROP INDEX \`uq_employee_email\` ON \`employees\`
        `);
    await queryRunner.query(`
            DROP INDEX \`ix_employee_name\` ON \`employees\`
        `);
    await queryRunner.query(`
            DROP INDEX \`ix_employee_role_status\` ON \`employees\`
        `);
    await queryRunner.query(`
            DROP TABLE \`employees\`
        `);
    await queryRunner.query(`
            DROP INDEX \`uq_position_code\` ON \`positions\`
        `);
    await queryRunner.query(`
            DROP INDEX \`uq_position_division\` ON \`positions\`
        `);
    await queryRunner.query(`
            DROP TABLE \`positions\`
        `);
    await queryRunner.query(`
            DROP INDEX \`uq_division_code\` ON \`divisions\`
        `);
    await queryRunner.query(`
            DROP TABLE \`divisions\`
        `);
  }
}
