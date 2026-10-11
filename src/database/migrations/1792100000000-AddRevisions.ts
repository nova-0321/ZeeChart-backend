import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The history of every project: one row per change to the project, a task or an event (#19). */
export class AddRevisions1792100000000 implements MigrationInterface {
  name = 'AddRevisions1792100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."revision_entity" AS ENUM('project', 'task', 'event')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."revision_action" AS ENUM('create', 'update', 'delete')`,
    );
    await queryRunner.query(
      `CREATE TABLE "revisions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL, "entityType" "public"."revision_entity" NOT NULL, "entityId" uuid NOT NULL, "version" integer NOT NULL, "action" "public"."revision_action" NOT NULL, "changedById" uuid, "summary" text NOT NULL, "before" jsonb, "after" jsonb, "batchId" uuid NOT NULL, "primary" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_revisions_entity_version" UNIQUE ("entityId", "version"), CONSTRAINT "PK_4aa9ee2c71c50508c3c501573c9" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_revisions_project_created" ON "revisions"  ("projectId", "createdAt") `,
    );
    await queryRunner.query(
      `ALTER TABLE "revisions" ADD CONSTRAINT "FK_02597cfde130023e5c2aa838457" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "revisions" ADD CONSTRAINT "FK_cc0e22239ffb5eb96a049773c57" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "revisions" DROP CONSTRAINT "FK_cc0e22239ffb5eb96a049773c57"`,
    );
    await queryRunner.query(
      `ALTER TABLE "revisions" DROP CONSTRAINT "FK_02597cfde130023e5c2aa838457"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_revisions_project_created"`);
    await queryRunner.query(`DROP TABLE "revisions"`);
    await queryRunner.query(`DROP TYPE "public"."revision_action"`);
    await queryRunner.query(`DROP TYPE "public"."revision_entity"`);
  }
}
