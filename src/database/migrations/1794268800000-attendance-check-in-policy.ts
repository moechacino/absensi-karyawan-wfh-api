import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AttendanceCheckInPolicy1794268800000 implements MigrationInterface {
  name = 'AttendanceCheckInPolicy1794268800000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      'ALTER TABLE `schedule_versions` ADD `opens_minutes_before_start` smallint UNSIGNED NOT NULL DEFAULT 15, ADD CONSTRAINT `ck_schedule_early` CHECK (`opens_minutes_before_start` <= 1440)',
    );
    await runner.query(
      'ALTER TABLE `attendances` ADD `opens_minutes_before_start` smallint UNSIGNED NOT NULL DEFAULT 15, ADD `missed_check_out` tinyint NOT NULL DEFAULT 0, ADD CONSTRAINT `ck_attendance_missed` CHECK (`missed_check_out` IN (0, 1) AND (`missed_check_out` = 0 OR (`check_out_at` IS NULL AND `duration_seconds` IS NULL)))',
    );
    await this.openExpression(
      runner,
      'CASE WHEN `check_out_at` IS NULL AND `missed_check_out` = 0 THEN `employee_id` ELSE NULL END',
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    const missed: unknown[] = await runner.query(
      'SELECT 1 FROM `attendances` WHERE `missed_check_out` = 1 LIMIT 1',
    );
    if (missed.length) {
      throw new Error(
        'Refusing to lose missed check-out records; use a forward migration.',
      );
    }

    await this.openExpression(
      runner,
      'CASE WHEN `check_out_at` IS NULL THEN `employee_id` ELSE NULL END',
    );
    await runner.query(
      'ALTER TABLE `attendances` DROP CHECK `ck_attendance_missed`, DROP `missed_check_out`, DROP `opens_minutes_before_start`',
    );
    await runner.query(
      'ALTER TABLE `schedule_versions` DROP CHECK `ck_schedule_early`, DROP `opens_minutes_before_start`',
    );
  }

  private async openExpression(
    runner: QueryRunner,
    expression: string,
  ): Promise<void> {
    await runner.query(
      'ALTER TABLE `attendances` MODIFY `open_employee_id` char(36) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (' +
        expression +
        ') STORED NULL',
    );
    await runner.query(
      'UPDATE `typeorm_metadata` SET `value` = ? WHERE `type` = ? AND `table` = ? AND `name` = ?',
      [expression, 'GENERATED_COLUMN', 'attendances', 'open_employee_id'],
    );
  }
}
