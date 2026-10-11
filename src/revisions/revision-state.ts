import type { EntityManager } from 'typeorm';
import type { EventState, LinkState, ProjectState, Snapshot, TaskState } from './revision-diff.js';

// A project as stored right now: its row, tasks, events and links, in the plain shape revisions
// keep (dates as "YYYY-MM-DD", cast to text in SQL: a date read as a JS Date would shift a day in
// a timezone east of UTC). Read with plain queries: what is in the database, nothing cached.

const dayOf = (value: unknown) => String(value).slice(0, 10);

export async function loadSnapshot(db: EntityManager, projectId: string): Promise<Snapshot> {
  // One after the other: inside a transaction they share one connection, which takes one query at
  // a time (pg deprecates sending the next before the last is answered).
  const projects = await db.query<ProjectState[]>(
    `SELECT "id", "name", "description", "archived" FROM "projects" WHERE "id" = $1`,
    [projectId],
  );
  const tasks = await db.query<
    (Omit<TaskState, 'startDate' | 'endDate'> & { startDate: unknown; endDate: unknown })[]
  >(
    `SELECT "id", "name", "description", "type", "priority", "startDate"::text AS "startDate", "endDate"::text AS "endDate", "progress",
              "color", "order", "parentId"
         FROM "tasks" WHERE "projectId" = $1`,
    [projectId],
  );
  const events = await db.query<
    (Omit<EventState, 'startDate' | 'endDate'> & { startDate: unknown; endDate: unknown })[]
  >(
    `SELECT "id", "name", "color", "startDate"::text AS "startDate", "endDate"::text AS "endDate" FROM "events" WHERE "projectId" = $1`,
    [projectId],
  );
  const links = await db.query<LinkState[]>(
    `SELECT "id", "fromTaskId", "toTaskId", "type", "lagDays" FROM "task_dependencies"
        WHERE "projectId" = $1`,
    [projectId],
  );
  return {
    project: projects[0] ?? null,
    tasks: new Map(
      tasks.map((task) => [
        task.id,
        { ...task, startDate: dayOf(task.startDate), endDate: dayOf(task.endDate) },
      ]),
    ),
    events: new Map(
      events.map((event) => [
        event.id,
        { ...event, startDate: dayOf(event.startDate), endDate: dayOf(event.endDate) },
      ]),
    ),
    links,
  };
}
