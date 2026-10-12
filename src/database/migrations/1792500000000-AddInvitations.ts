import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Invitations for people who have no account yet (#20): a project, an email and a role, until they
 * sign up with that email and become a member.
 */
export class AddInvitations1792500000000 implements MigrationInterface {
  name = 'AddInvitations1792500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "invitations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL, "email" character varying(254) NOT NULL, "role" "public"."member_role" NOT NULL, "invitedById" uuid, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_invitations_project_email" UNIQUE ("projectId", "email"), CONSTRAINT "PK_invitations" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_invitations_email" ON "invitations" ("email") `);
    await queryRunner.query(
      `ALTER TABLE "invitations" ADD CONSTRAINT "FK_invitations_project" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitations" ADD CONSTRAINT "FK_invitations_invited_by" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "invitations"`);
  }
}
