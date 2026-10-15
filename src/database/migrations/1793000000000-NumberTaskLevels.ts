import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Every list level (a group's tasks, or a project's top level) numbered 1, 2, 3... in its order
 * (#57). Before, a delete or a move out of a group left a gap, and a new task took the project's
 * highest number plus one; from now on each write keeps its level numbered so. Rows on the same
 * place keep the order the list showed them in (created first, then id).
 *
 * No down: the old numbers were only gaps, and the order stays the same.
 */
export class NumberTaskLevels1793000000000 implements MigrationInterface {
  name = 'NumberTaskLevels1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "tasks" t SET "order" = n."place"
         FROM (SELECT "id", ROW_NUMBER() OVER (
                 PARTITION BY "projectId", "parentId" ORDER BY "order", "createdAt", "id") AS "place"
                 FROM "tasks") n
        WHERE t."id" = n."id" AND t."order" <> n."place"`,
    );
  }

  public async down(): Promise<void> {}
}
