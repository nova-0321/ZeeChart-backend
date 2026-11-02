import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Every group's progress set to the average of its tasks (#80). From now on each write keeps it so
 * (fitGroupProgress); this sets the groups saved before, when a group's progress was typed in.
 *
 * The rule is written out here, not imported: TypeORM loads every migration file as it is (no
 * other source file can be imported from one), and a migration must keep doing what it did when it
 * ran. It is the rule of tasks/scheduling/group-progress.ts on the day it was added: the plain mean
 * of the group's direct tasks (a group inside counts with its own average), milestones left out,
 * 0 with nothing to count, rounded; a loop in old data counts as 0. The e2e test checks the two
 * agree.
 *
 * No down: the progress typed in before is not kept anywhere, and isn't wanted back.
 */

interface Row {
  id: string;
  projectId: string;
  parentId: string | null;
  type: string;
  progress: number;
}

export class GroupProgressFromTasks1793100000000 implements MigrationInterface {
  name = 'GroupProgressFromTasks1793100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT "id", "projectId", "parentId", "type", "progress" FROM "tasks"`,
    )) as Row[];
    const childrenOf = new Map<string, Row[]>();
    for (const row of rows) {
      if (!row.parentId) continue;
      const siblings = childrenOf.get(row.parentId);
      if (siblings) siblings.push(row);
      else childrenOf.set(row.parentId, [row]);
    }
    const average = new Map<string, number>();
    const visiting = new Set<string>();
    const progressOf = (group: Row): number => {
      const known = average.get(group.id);
      if (known !== undefined) return known;
      if (visiting.has(group.id)) return 0;
      visiting.add(group.id);
      const values = (childrenOf.get(group.id) ?? [])
        .filter((child) => child.type !== 'milestone')
        .map((child) => (child.type === 'group' ? progressOf(child) : child.progress));
      visiting.delete(group.id);
      const value = Math.round(
        values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length,
      );
      average.set(group.id, value);
      return value;
    };
    const changes = rows
      .filter((row) => row.type === 'group')
      .map((row) => ({ id: row.id, progress: progressOf(row), was: row.progress }))
      .filter((change) => change.progress !== change.was);
    if (changes.length === 0) return;
    await queryRunner.query(
      `UPDATE "tasks" t SET "progress" = c."progress"
         FROM unnest($1::uuid[], $2::int[]) AS c("id", "progress")
        WHERE t."id" = c."id"`,
      [changes.map((change) => change.id), changes.map((change) => change.progress)],
    );
  }

  public async down(): Promise<void> {}
}
