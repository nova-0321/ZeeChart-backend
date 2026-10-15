import type { EntityManager } from 'typeorm';
import { versionedRows } from '../database/versioned-rows.js';

// The project's own row as the history needs it (revisions: snapshots, undo and redo, restoring a
// version). It comes here, not to the table (#55). Each takes the caller's manager, so it runs in
// that transaction. The callers check the rules first (an owner's change; a free name).

/** A project as the history keeps it. */
export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
}

/** A project's version, set and read by the history. */
export const projectRows = versionedRows('projects');

/** The project as stored right now; null when it is gone. */
export async function projectRowOf(
  manager: EntityManager,
  projectId: string,
): Promise<ProjectRow | null> {
  const [row] = await manager.query<ProjectRow[]>(
    `SELECT "id", "name", "description", "archived" FROM "projects" WHERE "id" = $1`,
    [projectId],
  );
  return row ?? null;
}

/** The project's own fields and version, as a write's changes send them (#75); null when gone. */
export async function projectFieldsOf(
  manager: EntityManager,
  projectId: string,
): Promise<(ProjectRow & { version: number }) | null> {
  const [row] = await manager.query<(ProjectRow & { version: number })[]>(
    `SELECT "id", "name", "description", "archived", "version" FROM "projects" WHERE "id" = $1`,
    [projectId],
  );
  return row ?? null;
}

/** Writes its name, description and archived flag back as they were (undo and redo). */
export async function writeProjectRow(manager: EntityManager, project: ProjectRow) {
  await manager.query(
    `UPDATE "projects" SET "name" = $2, "description" = $3, "archived" = $4 WHERE "id" = $1`,
    [project.id, project.name, project.description, project.archived],
  );
}

/** Writes a version's description back, and its name when `withName` (restoring a version). */
export async function writeProjectFields(
  manager: EntityManager,
  projectId: string,
  fields: { name: string; description: string | null },
  withName: boolean,
) {
  await manager.query(
    `UPDATE "projects" SET "description" = $2, "name" = CASE WHEN $4 THEN $3 ELSE "name" END
      WHERE "id" = $1`,
    [projectId, fields.description, fields.name, withName],
  );
}
