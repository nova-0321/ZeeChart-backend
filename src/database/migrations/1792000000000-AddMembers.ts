import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Projects get members, each with a role (owner / editor / viewer), instead of a single owner.
 *
 * Every project's owner becomes its first member, with the role owner and joined when the project
 * was made, before `projects.ownerId` is dropped: no one loses a project.
 */
export class AddMembers1792000000000 implements MigrationInterface {
  name = 'AddMembers1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."member_role" AS ENUM('owner', 'editor', 'viewer')`,
    );
    await queryRunner.query(
      `CREATE TABLE "members" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL, "userId" uuid NOT NULL, "role" "public"."member_role" NOT NULL, "addedById" uuid, "joinedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_members_project_user" UNIQUE ("projectId", "userId"), CONSTRAINT "PK_28b53062261b996d9c99fa12404" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_members_userId" ON "members"  ("userId") `);
    await queryRunner.query(
      `ALTER TABLE "members" ADD CONSTRAINT "FK_da3e8adedb86281bf9203b1b0ec" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "members" ADD CONSTRAINT "FK_839756572a2c38eb5a3b563126e" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "members" ADD CONSTRAINT "FK_79f65ab2d862a64d42ac0293120" FOREIGN KEY ("addedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `INSERT INTO "members" ("projectId", "userId", "role", "joinedAt") SELECT "id", "ownerId", 'owner', "createdAt" FROM "projects"`,
    );

    await queryRunner.query(
      `ALTER TABLE "projects" DROP CONSTRAINT "FK_a8e7e6c3f9d9528ed35fe5bae33"`,
    );
    await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "UQ_projects_owner_name"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "ownerId"`);
  }

  // Each project goes back to one owner: the owner who joined it first. Editors and viewers lose
  // it. Going back fails if that leaves one owner with two projects of the same name.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" ADD "ownerId" uuid`);
    await queryRunner.query(
      `UPDATE "projects" p SET "ownerId" = (SELECT m."userId" FROM "members" m WHERE m."projectId" = p."id" AND m."role" = 'owner' ORDER BY m."joinedAt", m."id" LIMIT 1)`,
    );
    // A project whose owners all deleted their accounts can't go back (it would have no owner).
    await queryRunner.query(`DELETE FROM "projects" WHERE "ownerId" IS NULL`);
    await queryRunner.query(`ALTER TABLE "projects" ALTER COLUMN "ownerId" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "projects" ADD CONSTRAINT "UQ_projects_owner_name" UNIQUE ("ownerId", "name")`,
    );
    await queryRunner.query(
      `ALTER TABLE "projects" ADD CONSTRAINT "FK_a8e7e6c3f9d9528ed35fe5bae33" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await queryRunner.query(`DROP TABLE "members"`);
    await queryRunner.query(`DROP TYPE "public"."member_role"`);
  }
}
