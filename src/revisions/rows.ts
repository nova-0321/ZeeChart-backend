import type { VersionedRows } from '../database/versioned-rows.js';
import { linkRows } from '../dependencies/link-rows.js';
import { eventRows } from '../events/event-rows.js';
import { projectRows } from '../projects/project-rows.js';
import { taskRows } from '../tasks/task-rows.js';
import type { RevisionEntity } from './revision-diff.js';

/**
 * The rows the history follows, by kind: each kind's own domain reads and sets their versions and
 * deletes them (#55), not the history writing to their tables.
 */
export const ROWS: Record<RevisionEntity, VersionedRows> = {
  project: projectRows,
  task: taskRows,
  event: eventRows,
  link: linkRows,
};
