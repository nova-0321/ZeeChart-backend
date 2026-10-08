import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDependencyLag1791600000000 implements MigrationInterface {
  name = 'AddDependencyLag1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" ADD "lagDays" integer NOT NULL DEFAULT '0'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "task_dependencies" DROP COLUMN "lagDays"`);
  }
}
