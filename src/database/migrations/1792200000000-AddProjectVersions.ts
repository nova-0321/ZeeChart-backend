import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Versions of whole projects (#19). Every project already there gets its present state as v1, so
 * there is something to go back to from the start.
 */
export class AddProjectVersions1792200000000 implements MigrationInterface {
  name = 'AddProjectVersions1792200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."version_kind" AS ENUM('auto', 'manual', 'before-restore')`,
    );
    await queryRunner.query(
      `CREATE TABLE "project_versions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL, "number" integer NOT NULL, "kind" "public"."version_kind" NOT NULL, "starred" boolean NOT NULL DEFAULT false, "content" jsonb NOT NULL, "createdById" uuid, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_project_versions_number" UNIQUE ("projectId", "number"), CONSTRAINT "PK_0933adf663634f5c8c335e7b5e4" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_versions" ADD CONSTRAINT "FK_e03248bd62e51cc0dcf7c9712d1" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_versions" ADD CONSTRAINT "FK_8f901898d13071cb96ae4079609" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`INSERT INTO "project_versions" ("projectId", "number", "kind", "content")
SELECT p."id", 1, 'auto', jsonb_build_object(
  'project', jsonb_build_object('id', p."id", 'name', p."name", 'description', p."description", 'archived', p."archived"),
  'tasks', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', t."id", 'name', t."name", 'description', t."description", 'type', t."type",
      'priority', t."priority", 'startDate', t."startDate"::text, 'endDate', t."endDate"::text,
      'progress', t."progress", 'color', t."color", 'order', t."order", 'parentId', t."parentId")
      ORDER BY t."id") FROM "tasks" t WHERE t."projectId" = p."id"), '[]'::jsonb),
  'events', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', e."id", 'name', e."name", 'color', e."color",
      'startDate', e."startDate"::text, 'endDate', e."endDate"::text)
      ORDER BY e."id") FROM "events" e WHERE e."projectId" = p."id"), '[]'::jsonb),
  'links', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'fromTaskId', d."fromTaskId", 'toTaskId', d."toTaskId", 'type', d."type", 'lagDays', d."lagDays")
      ORDER BY d."fromTaskId", d."toTaskId") FROM "task_dependencies" d WHERE d."projectId" = p."id"), '[]'::jsonb))
FROM "projects" p`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "project_versions" DROP CONSTRAINT "FK_8f901898d13071cb96ae4079609"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_versions" DROP CONSTRAINT "FK_e03248bd62e51cc0dcf7c9712d1"`,
    );
    await queryRunner.query(`DROP TABLE "project_versions"`);
    await queryRunner.query(`DROP TYPE "public"."version_kind"`);
  }
}
