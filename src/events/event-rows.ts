import { In, type EntityManager } from 'typeorm';
import { ProjectEvent } from './entities/project-event.entity.js';
import { versionedRows } from '../database/versioned-rows.js';
import { placeEvents, type EventSpan } from './event-placing.js';

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

/**
 * The project's events as stored right now (dates cast to text: see taskRowsOf), in the order the
 * list shows them: by start, then the first made (lineUpEvents places them in this order).
 */
export async function eventRowsOf(manager: EntityManager, projectId: string): Promise<EventRow[]> {
  const rows = await manager.query<
    (Omit<EventRow, 'startDate' | 'endDate'> & { startDate: unknown; endDate: unknown })[]
  >(
    `SELECT "id", "name", "color", "startDate"::text AS "startDate", "endDate"::text AS "endDate"
       FROM "events" WHERE "projectId" = $1
      ORDER BY "startDate", "createdAt", "id"`,
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

/**
 * No two of the project's events share a day (#84, event-placing.ts): the events in `fixed` keep
 * their dates, and every other event that shares a day with one moves later, keeping its length.
 * In the caller's transaction; the moved events are written in one statement, so they are part of
 * that write (its history batch, its change message, its undo). Returns the events it moved.
 *
 * With nothing fixed, the events are lined up by start (a restored version, or a project copied
 * from one, may come from before the rule).
 */
export async function lineUpEvents(
  manager: EntityManager,
  projectId: string,
  fixed: ReadonlySet<string> = new Set(),
): Promise<EventSpan[]> {
  const rows = await eventRowsOf(manager, projectId);
  const moved = placeEvents(
    rows.filter((row) => fixed.has(row.id)),
    rows.filter((row) => !fixed.has(row.id)),
  );
  if (moved.length === 0) return moved;
  await manager.query(
    `UPDATE "events" e SET "startDate" = m."startDate", "endDate" = m."endDate", "updatedAt" = now()
       FROM unnest($1::uuid[], $2::date[], $3::date[]) AS m("id", "startDate", "endDate")
      WHERE e."id" = m."id"`,
    [
      moved.map((event) => event.id),
      moved.map((event) => event.startDate),
      moved.map((event) => event.endDate),
    ],
  );
  return moved;
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

/** Events as the REST API returns them: the rows a write changed, sent with it (#75). */
export function eventsWithIds(manager: EntityManager, ids: string[]): Promise<ProjectEvent[]> {
  return ids.length === 0 ? Promise.resolve([]) : manager.findBy(ProjectEvent, { id: In(ids) });
}
