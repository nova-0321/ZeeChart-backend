import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTaskDependencies1791500000000 implements MigrationInterface {
  name = 'AddTaskDependencies1791500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."task_dependencies_type_enum" AS ENUM('FS', 'SS', 'FF', 'SF')`,
    );
    await queryRunner.query(
      `CREATE TABLE "task_dependencies" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "projectId" uuid NOT NULL, "fromTaskId" uuid NOT NULL, "toTaskId" uuid NOT NULL, "type" "public"."task_dependencies_type_enum" NOT NULL DEFAULT 'FS', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_task_dependencies_pair" UNIQUE ("fromTaskId", "toTaskId"), CONSTRAINT "PK_task_dependencies" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" ADD CONSTRAINT "FK_task_dependencies_from" FOREIGN KEY ("fromTaskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "task_dependencies" ADD CONSTRAINT "FK_task_dependencies_to" FOREIGN KEY ("toTaskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "task_dependencies"`);
    await queryRunner.query(`DROP TYPE "public"."task_dependencies_type_enum"`);
  }
}
