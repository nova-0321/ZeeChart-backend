import { In, type EntityManager } from 'typeorm';
import { TaskDependency } from './entities/task-dependency.entity.js';
import { versionedRows } from '../database/versioned-rows.js';
import { existingTaskIds } from '../tasks/task-rows.js';

// The links' rows as other domains need them: the scheduler (which tasks wait for which) and the
// history (snapshots, undo and redo, restoring and copying a version). They come here, not to the
// table (#55). Each takes the caller's manager, so it runs in that transaction, on its connection.

/** A link as the scheduler and the history read it. */
export interface LinkRow {
  id: string;
  fromTaskId: string;
  toTaskId: string;
  type: string;
  lagDays: number;
}

/** A link's version, set and read by the history, and its deletion (undo). */
export const linkRows = versionedRows('task_dependencies');

/** The project's links as stored right now. */
export function linksOf(manager: EntityManager, projectId: string): Promise<LinkRow[]> {
  return manager.query(
    `SELECT "id", "fromTaskId", "toTaskId", "type", "lagDays" FROM "task_dependencies"
        WHERE "projectId" = $1`,
    [projectId],
  );
}

/**
 * A link, with its own id when it has one (so its history goes on), where both tasks are there:
 * written over when it is there (by id), left out when the same two tasks are linked already.
 */
export async function writeLink(
  manager: EntityManager,
  projectId: string,
  link: Omit<LinkRow, 'id'> & { id?: string },
) {
  // Both tasks there (asked of the tasks domain, in this transaction), or no link.
  const there = await existingTaskIds(manager, [link.fromTaskId, link.toTaskId]);
  if (!there.has(link.fromTaskId) || !there.has(link.toTaskId)) return;
  await manager.query(
    `INSERT INTO "task_dependencies" ("id", "projectId", "fromTaskId", "toTaskId", "type", "lagDays")
     SELECT COALESCE($6::uuid, uuid_generate_v4()), $1, $2, $3, $4, $5
      WHERE NOT EXISTS (SELECT 1 FROM "task_dependencies"
                         WHERE "fromTaskId" = $2 AND "toTaskId" = $3
                           AND "id" IS DISTINCT FROM $6::uuid)
     ON CONFLICT ("id") DO UPDATE SET "type" = EXCLUDED."type", "lagDays" = EXCLUDED."lagDays"`,
    [projectId, link.fromTaskId, link.toTaskId, link.type, link.lagDays, link.id ?? null],
  );
}

/** Removes all the project's links (restoring a version writes the version's back). */
export async function deleteLinksOf(manager: EntityManager, projectId: string) {
  await manager.query(`DELETE FROM "task_dependencies" WHERE "projectId" = $1`, [projectId]);
}

/** Links as the REST API returns them: the rows a write changed, sent with it (#75). */
export function linksWithIds(manager: EntityManager, ids: string[]): Promise<TaskDependency[]> {
  return ids.length === 0 ? Promise.resolve([]) : manager.findBy(TaskDependency, { id: In(ids) });
}
