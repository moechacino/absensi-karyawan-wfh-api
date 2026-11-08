import type { MigrationInterface, QueryRunner } from 'typeorm';

// Generated with migration:generate, then reviewed to preserve existing codes/indexes.
export class OrganizationCodeLength1794127860128 implements MigrationInterface {
  name = 'OrganizationCodeLength1794127860128';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `divisions` MODIFY `code` varchar(40) NOT NULL',
    );
    await queryRunner.query(
      'ALTER TABLE `positions` MODIFY `code` varchar(40) NOT NULL',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['divisions', 'positions']) {
      const rows: unknown[] = await queryRunner.query(
        'SELECT 1 FROM `' + table + '` WHERE CHAR_LENGTH(`code`) > 32 LIMIT 1',
      );

      if (rows.length) {
        throw new Error(
          'Refusing to truncate organization codes; preserve data and use a reviewed forward migration.',
        );
      }
    }

    await queryRunner.query(
      'ALTER TABLE `positions` MODIFY `code` varchar(32) NOT NULL',
    );
    await queryRunner.query(
      'ALTER TABLE `divisions` MODIFY `code` varchar(32) NOT NULL',
    );
  }
}
