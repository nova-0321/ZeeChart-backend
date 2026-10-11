import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A version (count of changes) on projects, tasks, events and links, for conflict checks (#21). It
 * starts at each row's last revision number, the counter it shares from now on.
 */

export class AddVersionColumns1792400000000 implements MigrationInterface {
  name = 'AddVersionColumns1792400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" ADD "version" integer NOT NULL DEFAULT '0'`);
    await queryRunner.query(`ALTER TABLE "tasks" ADD "version" integer NOT NULL DEFAULT '0'`);
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" ADD "version" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(`ALTER TABLE "events" ADD "version" integer NOT NULL DEFAULT '0'`);
    await queryRunner.query(
      `UPDATE "projects" r SET "version" = COALESCE((SELECT MAX(v."version") FROM "revisions" v WHERE v."entityId" = r."id"), 0)`,
    );
    await queryRunner.query(
      `UPDATE "tasks" r SET "version" = COALESCE((SELECT MAX(v."version") FROM "revisions" v WHERE v."entityId" = r."id"), 0)`,
    );
    await queryRunner.query(
      `UPDATE "task_dependencies" r SET "version" = COALESCE((SELECT MAX(v."version") FROM "revisions" v WHERE v."entityId" = r."id"), 0)`,
    );
    await queryRunner.query(
      `UPDATE "events" r SET "version" = COALESCE((SELECT MAX(v."version") FROM "revisions" v WHERE v."entityId" = r."id"), 0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "events" DROP COLUMN "version"`);
    await queryRunner.query(`ALTER TABLE "task_dependencies" DROP COLUMN "version"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP COLUMN "version"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "version"`);
  }
}
