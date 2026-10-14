import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A number on each account that ends every sign-in at once when it is raised (sign out
 * everywhere, #49). Every account starts at 0, and tokens made before this have no number, which
 * counts as 0 too, so nobody is signed out by this change.
 */
export class AddTokenVersion1792800000000 implements MigrationInterface {
  name = 'AddTokenVersion1792800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD "tokenVersion" integer NOT NULL DEFAULT '0'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "tokenVersion"`);
  }
}
