import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes for the lookups every request makes: a project's tasks, links and events, a group's
 * children, the links into a task, and an undo batch. (A row's versions already have one: the
 * unique rule on entityId, version.)
 */
export class AddIndexes1792600000000 implements MigrationInterface {
  name = 'AddIndexes1792600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX "IDX_tasks_projectId" ON "tasks" ("projectId") `);
    await queryRunner.query(`CREATE INDEX "IDX_tasks_parentId" ON "tasks" ("parentId") `);
    await queryRunner.query(
      `CREATE INDEX "IDX_task_dependencies_projectId" ON "task_dependencies" ("projectId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_task_dependencies_toTaskId" ON "task_dependencies" ("toTaskId") `,
    );
    await queryRunner.query(`CREATE INDEX "IDX_events_projectId" ON "events" ("projectId") `);
    await queryRunner.query(`CREATE INDEX "IDX_revisions_batchId" ON "revisions" ("batchId") `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_revisions_batchId"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_events_projectId"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_task_dependencies_toTaskId"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_task_dependencies_projectId"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_tasks_parentId"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_tasks_projectId"`);
  }
}
