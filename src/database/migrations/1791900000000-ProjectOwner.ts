import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Every project has an owner (a user); a name is unique among one owner's projects.
 *
 * Projects made before there were accounts have no owner and none can be given to them, so they
 * are deleted first (their tasks, links and events go with them, by cascade).
 */
export class ProjectOwner1791900000000 implements MigrationInterface {
  name = 'ProjectOwner1791900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "projects"`);
    await queryRunner.query(`ALTER TABLE "projects" ADD "ownerId" uuid NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "projects" DROP CONSTRAINT "UQ_2187088ab5ef2a918473cb99007"`,
    );
    await queryRunner.query(
      `ALTER TABLE "projects" ADD CONSTRAINT "UQ_projects_owner_name" UNIQUE ("ownerId", "name")`,
    );
    await queryRunner.query(
      `ALTER TABLE "projects" ADD CONSTRAINT "FK_a8e7e6c3f9d9528ed35fe5bae33" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  // Going back fails if two owners have a project of the same name (names were unique for all).
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" DROP CONSTRAINT "FK_a8e7e6c3f9d9528ed35fe5bae33"`,
    );
    await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "UQ_projects_owner_name"`);
    await queryRunner.query(
      `ALTER TABLE "projects" ADD CONSTRAINT "UQ_2187088ab5ef2a918473cb99007" UNIQUE ("name")`,
    );
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "ownerId"`);
  }
}
