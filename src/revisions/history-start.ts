import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { ProjectVersion } from './entities/project-version.entity.js';
import { Revision } from './entities/revision.entity.js';
import type { ProjectState } from './history/revision-diff.js';

/**
 * The start of a new project's history, written by the projects domain in the transaction that
 * creates it (#55: not by writing the history's tables itself): its first revision ("Created
 * project", version 1) and its first version, v1, empty. Later changes are recorded by
 * RevisionInterceptor, and later versions saved as it changes.
 */
export async function startHistory(
  manager: EntityManager,
  project: ProjectState,
  userId: string,
): Promise<void> {
  await manager.save(
    manager.create(Revision, {
      projectId: project.id,
      entityType: 'project',
      entityId: project.id,
      version: 1,
      action: 'create',
      changedById: userId,
      summary: `Created project “${project.name}”`,
      before: null,
      after: { ...project },
      batchId: randomUUID(),
      primary: true,
    }),
  );
  await manager.save(
    manager.create(ProjectVersion, {
      projectId: project.id,
      number: 1,
      kind: 'auto',
      content: { project, tasks: [], events: [], links: [] },
      createdById: userId,
    }),
  );
}
