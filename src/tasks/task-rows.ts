import { In, type EntityManager } from 'typeorm';
import { Task } from './entities/task.entity.js';
import { versionedRows } from '../database/versioned-rows.js';

// The tasks' rows as the history needs them (revisions: snapshots, undo and redo, restoring and
// copying a version). They come here, not to the table (#55). Plain SQL on purpose: a saved state
// was consistent when it was saved (groups covered their tasks, links held), so it is written back
// as it is, not planned again by the scheduler. Each takes the caller's manager, so it runs in that
// transaction; the callers check first that nothing else changed what they put back.

/** A task as the history keeps it (dates "YYYY-MM-DD"). */
export interface TaskRow {
  id: string;
  name: string;
  description: string | null;
  type: string;
  priority: string;
  startDate: string;
  endDate: string;
  progress: number;
  color: string;
  order: number;
  parentId: string | null;
}

/** A task's version, set and read by the history, and its deletion (undo). */
export const taskRows = versionedRows('tasks');

const dayOf = (value: unknown) => String(value).slice(0, 10);

/**
 * The project's tasks as stored right now. Dates cast to text in SQL: a date read as a JS Date
 * would shift a day in a timezone east of UTC.
 */
export async function taskRowsOf(manager: EntityManager, projectId: string): Promise<TaskRow[]> {
  const rows = await manager.query<
    (Omit<TaskRow, 'startDate' | 'endDate'> & { startDate: unknown; endDate: unknown })[]
  >(
    `SELECT "id", "name", "description", "type", "priority", "startDate"::text AS "startDate", "endDate"::text AS "endDate", "progress",
              "color", "order", "parentId"
         FROM "tasks" WHERE "projectId" = $1`,
    [projectId],
  );
  return rows.map((row) => ({
    ...row,
    startDate: dayOf(row.startDate),
    endDate: dayOf(row.endDate),
  }));
}

/** A task as it was, except its group (see setTaskParent): inserted, or written over. */
export async function writeTask(manager: EntityManager, projectId: string, task: TaskRow) {
  await manager.query(
    `INSERT INTO "tasks" ("id", "projectId", "name", "description", "type", "priority",
                          "startDate", "endDate", "progress", "color", "order", "parentId")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)
     ON CONFLICT ("id") DO UPDATE SET
       "name" = EXCLUDED."name", "description" = EXCLUDED."description",
       "type" = EXCLUDED."type", "priority" = EXCLUDED."priority",
       "startDate" = EXCLUDED."startDate", "endDate" = EXCLUDED."endDate",
       "progress" = EXCLUDED."progress", "color" = EXCLUDED."color",
       "order" = EXCLUDED."order", "parentId" = NULL, "updatedAt" = now()`,
    [
      task.id,
      projectId,
      task.name,
      task.description,
      task.type,
      task.priority,
      task.startDate,
      task.endDate,
      task.progress,
      task.color,
      task.order,
    ],
  );
}

/**
 * A task's group, written after all the tasks are (a group may be written after what it holds).
 * A group that isn't there leaves it at the top level.
 */
export async function setTaskParent(manager: EntityManager, id: string, parentId: string | null) {
  await manager.query(
    `UPDATE "tasks" SET "parentId" =
       (SELECT "id" FROM "tasks" WHERE "id" = $2::uuid)
     WHERE "id" = $1`,
    [id, parentId],
  );
}

/** The task's group as stored now: null at the top level; undefined when the task is gone. */
export async function parentIdOf(
  manager: EntityManager,
  id: string,
): Promise<string | null | undefined> {
  const [row] = await manager.query<{ parentId: string | null }[]>(
    `SELECT "parentId" FROM "tasks" WHERE "id" = $1`,
    [id],
  );
  return row?.parentId;
}

/** Which of `ids` are tasks that are there. */
export async function existingTaskIds(manager: EntityManager, ids: string[]): Promise<Set<string>> {
  const rows = await manager.query<{ id: string }[]>(
    `SELECT "id" FROM "tasks" WHERE "id" = ANY($1::uuid[])`,
    [ids],
  );
  return new Set(rows.map((row) => row.id));
}

/** The project's group tree: each task with its group and type. */
export function taskTreeOf(
  manager: EntityManager,
  projectId: string,
): Promise<{ id: string; parentId: string | null; type: string }[]> {
  return manager.query(`SELECT "id", "parentId", "type" FROM "tasks" WHERE "projectId" = $1`, [
    projectId,
  ]);
}

/** Removes the project's tasks other than `keep` (restoring a version). */
export async function deleteTasksExcept(manager: EntityManager, projectId: string, keep: string[]) {
  await manager.query(
    `DELETE FROM "tasks" WHERE "projectId" = $1 AND NOT ("id" = ANY($2::uuid[]))`,
    [projectId, keep],
  );
}

/**
 * Each list level (a group's tasks, or the top level: null) numbered 1, 2, 3... in its order, with
 * no gap (a task gone) and no two on one place (a task made again): the ones in `first` before the
 * others on the same place. A level already numbered so is left as it is.
 */
export async function numberLevels(
  manager: EntityManager,
  projectId: string,
  levels: Iterable<string | null>,
  first: Set<string> = new Set(),
) {
  for (const parentId of new Set(levels)) {
    const rows = await manager.query<{ id: string; order: number; createdAt: Date }[]>(
      `SELECT "id", "order", "createdAt" FROM "tasks"
        WHERE "projectId" = $1 AND "parentId" IS NOT DISTINCT FROM $2::uuid`,
      [projectId, parentId],
    );
    rows.sort(
      (a, b) =>
        a.order - b.order ||
        Number(first.has(b.id)) - Number(first.has(a.id)) ||
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
        (a.id < b.id ? -1 : 1),
    );
    for (const [index, row] of rows.entries()) {
      if (row.order !== index + 1) {
        await manager.query(`UPDATE "tasks" SET "order" = $2 WHERE "id" = $1`, [row.id, index + 1]);
      }
    }
  }
}

/**
 * Every level of the project numbered as numberLevels does (a whole version put back: one saved
 * before levels were kept numbered may have gaps). One statement; rows already right are not
 * written.
 */
export async function numberAllLevels(manager: EntityManager, projectId: string) {
  await manager.query(
    `UPDATE "tasks" t SET "order" = n."place"
       FROM (SELECT "id", ROW_NUMBER() OVER (
               PARTITION BY "parentId" ORDER BY "order", "createdAt", "id") AS "place"
               FROM "tasks" WHERE "projectId" = $1) n
      WHERE t."id" = n."id" AND t."order" <> n."place"`,
    [projectId],
  );
}

/**
 * Puts a task at `place` (0 first) among the tasks of its list (`parentId`; null: the top level)
 * as they are now, the others keeping their order; the list is numbered from 1 again.
 */
export async function putAtPlace(
  manager: EntityManager,
  projectId: string,
  taskId: string,
  parentId: string | null,
  place: number,
) {
  const rows = await manager.query<{ id: string; order: number }[]>(
    `SELECT "id", "order" FROM "tasks"
      WHERE "projectId" = $1 AND "parentId" IS NOT DISTINCT FROM $2::uuid AND "id" <> $3
      ORDER BY "order", "id"`,
    [projectId, parentId, taskId],
  );
  const level = rows.map((row) => row.id);
  level.splice(Math.min(Math.max(place, 0), level.length), 0, taskId);
  const was = new Map(rows.map((row) => [row.id, row.order]));
  for (const [index, id] of level.entries()) {
    if (was.get(id) !== index + 1) {
      await manager.query(`UPDATE "tasks" SET "order" = $2 WHERE "id" = $1`, [id, index + 1]);
    }
  }
}

/** Tasks as the REST API returns them: the rows a write changed, sent with it (#75). */
export function tasksWithIds(manager: EntityManager, ids: string[]): Promise<Task[]> {
  return ids.length === 0 ? Promise.resolve([]) : manager.findBy(Task, { id: In(ids) });
}
