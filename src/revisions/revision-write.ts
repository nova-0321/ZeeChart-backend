import type { EntityManager } from 'typeorm';
import type { EventState, LinkState, TaskState } from './revision-diff.js';

// Writing saved states back as they were, for restoring a version and for undo / redo. Plain SQL
// on purpose: these states were consistent when they were saved (groups covered their tasks, links
// held), so they are written as they are, not planned again by the scheduler. Callers run them in
// one transaction and check first that nothing else changed what they put back.

/** A task as it was, except its group (see setTaskParent): inserted, or written over. */
export async function writeTask(manager: EntityManager, projectId: string, task: TaskState) {
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

export async function writeEvent(manager: EntityManager, projectId: string, event: EventState) {
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
 * A link, with its own id when it has one (so its history goes on), where both tasks are there:
 * written over when it is there (by id), left out when the same two tasks are linked already.
 */
export async function writeLink(manager: EntityManager, projectId: string, link: LinkState) {
  await manager.query(
    `INSERT INTO "task_dependencies" ("id", "projectId", "fromTaskId", "toTaskId", "type", "lagDays")
     SELECT COALESCE($6::uuid, uuid_generate_v4()), $1, $2, $3, $4, $5
      WHERE EXISTS (SELECT 1 FROM "tasks" WHERE "id" = $2)
        AND EXISTS (SELECT 1 FROM "tasks" WHERE "id" = $3)
        AND NOT EXISTS (SELECT 1 FROM "task_dependencies"
                         WHERE "fromTaskId" = $2 AND "toTaskId" = $3
                           AND "id" IS DISTINCT FROM $6::uuid)
     ON CONFLICT ("id") DO UPDATE SET "type" = EXCLUDED."type", "lagDays" = EXCLUDED."lagDays"`,
    [projectId, link.fromTaskId, link.toTaskId, link.type, link.lagDays, link.id ?? null],
  );
}
