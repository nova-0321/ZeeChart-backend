import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSchema1791443501509 implements MigrationInterface {
  name = 'InitSchema1791443501509';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "tasks_type_enum" AS ENUM('group', 'task', 'milestone')`);
    await queryRunner.query(`CREATE TYPE "tasks_priority_enum" AS ENUM('low', 'medium', 'high')`);
    await queryRunner.query(
      `CREATE TABLE "tasks" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" text NOT NULL, "description" text, "progress" integer NOT NULL, "projectId" uuid NOT NULL, "type" "tasks_type_enum" NOT NULL DEFAULT 'task', "priority" "tasks_priority_enum" NOT NULL DEFAULT 'medium', "startDate" date NOT NULL DEFAULT ('now'::text)::date, "endDate" date NOT NULL DEFAULT ('now'::text)::date, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "color" text NOT NULL, "order" integer NOT NULL, "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "parentId" uuid, CONSTRAINT "PK_8d12ff38fcc62aaba2cab748772" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "projects" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying(255) NOT NULL, "description" text, "archived" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_2187088ab5ef2a918473cb99007" UNIQUE ("name"), CONSTRAINT "PK_6271df0a7aed1d6c0691ce6ac50" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "task_dependencies_type_enum" AS ENUM('FS', 'SS', 'FF', 'SF')`,
    );
    await queryRunner.query(
      `CREATE TABLE "task_dependencies" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL, "fromTaskId" uuid NOT NULL, "toTaskId" uuid NOT NULL, "type" "task_dependencies_type_enum" NOT NULL DEFAULT 'FS', "lagDays" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_42d40cafc4dd0549b210972606f" UNIQUE ("fromTaskId", "toTaskId"), CONSTRAINT "PK_e31de0e173af595a21c4ec8e48b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD CONSTRAINT "FK_1cbec65196d4cf86dd8ab464085" FOREIGN KEY ("parentId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD CONSTRAINT "FK_e08fca67ca8966e6b9914bf2956" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" ADD CONSTRAINT "FK_27751a5ad6055bd133beac36b31" FOREIGN KEY ("fromTaskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" ADD CONSTRAINT "FK_94c1f18f6b85c50111da0479fa7" FOREIGN KEY ("toTaskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" DROP CONSTRAINT "FK_94c1f18f6b85c50111da0479fa7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" DROP CONSTRAINT "FK_27751a5ad6055bd133beac36b31"`,
    );
    await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_e08fca67ca8966e6b9914bf2956"`);
    await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_1cbec65196d4cf86dd8ab464085"`);
    await queryRunner.query(`DROP TABLE "task_dependencies"`);
    await queryRunner.query(`DROP TYPE "task_dependencies_type_enum"`);
    await queryRunner.query(`DROP TABLE "projects"`);
    await queryRunner.query(`DROP TABLE "tasks"`);
    await queryRunner.query(`DROP TYPE "tasks_priority_enum"`);
    await queryRunner.query(`DROP TYPE "tasks_type_enum"`);
  }
}
