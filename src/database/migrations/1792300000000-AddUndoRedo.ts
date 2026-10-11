import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Undo and redo: what each batch of revisions was (a change, an undo, a redo) and of which batch.
 * Links get a history of their own too.
 */

export class AddUndoRedo1792300000000 implements MigrationInterface {
  name = 'AddUndoRedo1792300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."revision_batch_kind" AS ENUM('change', 'undo', 'redo')`,
    );
    await queryRunner.query(
      `ALTER TABLE "revisions" ADD "batchKind" "public"."revision_batch_kind" NOT NULL DEFAULT 'change'`,
    );
    await queryRunner.query(`ALTER TABLE "revisions" ADD "ofBatch" uuid`);
    await queryRunner.query(`ALTER TYPE "public"."revision_entity" ADD VALUE 'link'`);
    await queryRunner.query(
      `CREATE INDEX "IDX_revisions_project_author" ON "revisions"  ("projectId", "changedById", "createdAt") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_revisions_project_author"`);
    // The old type has no links: their history goes first.
    await queryRunner.query(`DELETE FROM "revisions" WHERE "entityType" = 'link'`);
    await queryRunner.query(
      `CREATE TYPE "public"."revision_entity_old" AS ENUM('project', 'task', 'event')`,
    );
    await queryRunner.query(
      `ALTER TABLE "revisions" ALTER COLUMN "entityType" TYPE "public"."revision_entity_old" USING "entityType"::"text"::"public"."revision_entity_old"`,
    );
    await queryRunner.query(`DROP TYPE "public"."revision_entity"`);
    await queryRunner.query(
      `ALTER TYPE "public"."revision_entity_old" RENAME TO "revision_entity"`,
    );
    await queryRunner.query(`ALTER TABLE "revisions" DROP COLUMN "ofBatch"`);
    await queryRunner.query(`ALTER TABLE "revisions" DROP COLUMN "batchKind"`);
    await queryRunner.query(`DROP TYPE "public"."revision_batch_kind"`);
  }
}
