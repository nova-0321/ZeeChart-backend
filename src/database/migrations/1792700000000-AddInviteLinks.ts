import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Invitations are taken up with a secret link, not by signing up with the email (#20): the hash of
 * the link's secret, and when it stops working. Invitations already waiting get a hash no link has
 * (an owner makes them a new link) and two weeks.
 */
export class AddInviteLinks1792700000000 implements MigrationInterface {
  name = 'AddInviteLinks1792700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "invitations" ADD "tokenHash" character varying(64)`);
    await queryRunner.query(
      `UPDATE "invitations" SET "tokenHash" = md5(random()::text || "id"::text) || md5("id"::text || random()::text)`,
    );
    await queryRunner.query(`ALTER TABLE "invitations" ALTER COLUMN "tokenHash" SET NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "invitations" ADD "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now() + interval '14 days'`,
    );
    await queryRunner.query(`ALTER TABLE "invitations" ALTER COLUMN "expiresAt" DROP DEFAULT`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_invitations_tokenHash" ON "invitations" ("tokenHash") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_invitations_tokenHash"`);
    await queryRunner.query(`ALTER TABLE "invitations" DROP COLUMN "expiresAt"`);
    await queryRunner.query(`ALTER TABLE "invitations" DROP COLUMN "tokenHash"`);
  }
}
