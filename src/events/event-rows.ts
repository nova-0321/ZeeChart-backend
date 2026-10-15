import type { EntityManager } from 'typeorm';
import { versionedRows } from '../database/versioned-rows.js';

// The events' rows as the history needs them (revisions: snapshots, undo and redo, restoring and
// copying a version). They come here, not to the table (#55). Each takes the caller's manager, so
// it runs in that transaction.

/** An event as the history keeps it (dates "YYYY-MM-DD"). */
export interface EventRow {
  id: string;
  name: string;
  color: string;
  startDate: string;
  endDate: string;
}

/** An event's version, set and read by the history, and its deletion (undo). */
export const eventRows = versionedRows('events');

const dayOf = (value: unknown) => String(value).slice(0, 10);

/** The project's events as stored right now (dates cast to text: see taskRowsOf). */
export async function eventRowsOf(manager: EntityManager, projectId: string): Promise<EventRow[]> {
  const rows = await manager.query<
    (Omit<EventRow, 'startDate' | 'endDate'> & { startDate: unknown; endDate: unknown })[]
  >(
    `SELECT "id", "name", "color", "startDate"::text AS "startDate", "endDate"::text AS "endDate" FROM "events" WHERE "projectId" = $1`,
    [projectId],
  );
  return rows.map((row) => ({
    ...row,
    startDate: dayOf(row.startDate),
    endDate: dayOf(row.endDate),
  }));
}

/** An event as it was: inserted, or written over. */
export async function writeEvent(manager: EntityManager, projectId: string, event: EventRow) {
  await manager.query(
    `INSERT INTO "events" ("id", "projectId", "name", "color", "startDate", "endDate")
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ("id") DO UPDATE SET
       "name" = EXCLUDED."name", "color" = EXCLUDED."color",
       "startDate" = EXCLUDED."startDate", "endDate" = EXCLUDED."endDate", "updatedAt" = now()`,
    [event.id, projectId, event.name, event.color, event.startDate, event.endDate],
  );
}

/** Removes the project's events other than `keep` (restoring a version). */
export async function deleteEventsExcept(
  manager: EntityManager,
  projectId: string,
  keep: string[],
) {
  await manager.query(
    `DELETE FROM "events" WHERE "projectId" = $1 AND NOT ("id" = ANY($2::uuid[]))`,
    [projectId, keep],
  );
}
