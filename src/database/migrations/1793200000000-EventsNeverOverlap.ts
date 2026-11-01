import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Each project's events lined up once so no two share a day (#84). From now on each write keeps
 * them so (events/event-placing.ts); events saved before could overlap, and the chart stacked them.
 * By start date (then the first made), each event that shares a day with one before it moves to
 * start the day after that one ends, keeping its length.
 *
 * The rule is written out here, not imported: TypeORM loads every migration file as it is, and a
 * migration must keep doing what it did when it ran. The e2e test checks it lines up as the app does.
 *
 * No down: the overlapping dates are not wanted back.
 */

interface Row {
  id: string;
  projectId: string;
  startDate: string;
  endDate: string;
}

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

export class EventsNeverOverlap1793200000000 implements MigrationInterface {
  name = 'EventsNeverOverlap1793200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT "id", "projectId", "startDate"::text AS "startDate", "endDate"::text AS "endDate"
         FROM "events" ORDER BY "projectId", "startDate", "createdAt", "id"`,
    )) as Row[];
    const moved: { id: string; startDate: string; endDate: string }[] = [];
    let project = '';
    // The last day taken so far in this project: in start order, each event only has to start
    // after the latest end before it.
    let lastEnd = -Infinity;
    for (const row of rows) {
      if (row.projectId !== project) {
        project = row.projectId;
        lastEnd = -Infinity;
      }
      const was = dayNumber(row.startDate);
      const length = dayNumber(row.endDate) - was;
      const start = Math.max(was, lastEnd + 1);
      lastEnd = start + length;
      if (start !== was)
        moved.push({ id: row.id, startDate: dateOf(start), endDate: dateOf(lastEnd) });
    }
    if (moved.length === 0) return;
    await queryRunner.query(
      `UPDATE "events" e SET "startDate" = m."startDate", "endDate" = m."endDate"
         FROM unnest($1::uuid[], $2::date[], $3::date[]) AS m("id", "startDate", "endDate")
        WHERE e."id" = m."id"`,
      [moved.map((m) => m.id), moved.map((m) => m.startDate), moved.map((m) => m.endDate)],
    );
  }

  public async down(): Promise<void> {}
}
