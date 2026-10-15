import type { EntityManager } from 'typeorm';
import { linksWithIds } from '../dependencies/link-rows.js';
import { eventsWithIds } from '../events/event-rows.js';
import { projectFieldsOf } from '../projects/project-rows.js';
import { MAX_CHANGED_ROWS, type RowChange, type RowChanges } from '../realtime/realtime.types.js';
import { tasksWithIds } from '../tasks/task-rows.js';
import type { Snapshot } from './history/revision-diff.js';

// The rows a write changed (#75), sent with its change message and in its answer, so a tab shows
// them without loading the project again. Worked out from the snapshots the history already takes
// before and after the write (RevisionInterceptor): every field counts, so a task only renumbered
// (its order) is in it too, though the history doesn't record that as a change of its own.

interface ChangedIds {
  upsert: string[];
  delete: string[];
}

/** Rows that are new or differ in any field, and rows that are gone. */
function diffIds<Row>(before: ReadonlyMap<string, Row>, after: ReadonlyMap<string, Row>) {
  const ids: ChangedIds = { upsert: [], delete: [] };
  for (const [id, row] of after) {
    const was = before.get(id);
    if (!was || JSON.stringify(was) !== JSON.stringify(row)) ids.upsert.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) ids.delete.push(id);
  return ids;
}

const byId = <Row extends { id?: string }>(rows: readonly Row[]) =>
  new Map(rows.flatMap((row) => (row.id ? [[row.id, row] as const] : [])));

const count = (ids: ChangedIds) => ids.upsert.length + ids.delete.length;

/** The rows of one kind, read back as the REST API returns them; absent when none changed. */
async function rowsOf(ids: ChangedIds, read: (ids: string[]) => Promise<object[]>) {
  if (count(ids) === 0) return undefined;
  const change: RowChange = { upsert: await read(ids.upsert), delete: ids.delete };
  return change;
}

/**
 * What the write changed, read in its transaction (after its history: the rows carry their new
 * versions). undefined when it is too much to send (over MAX_CHANGED_ROWS rows), or the project is
 * gone (a project deleted: there is nothing to show).
 */
export async function changedRows(
  manager: EntityManager,
  projectId: string,
  before: Snapshot,
  after: Snapshot,
): Promise<RowChanges | undefined> {
  if (!after.project) return undefined;
  const tasks = diffIds(before.tasks, after.tasks);
  const links = diffIds(byId(before.links), byId(after.links));
  const events = diffIds(before.events, after.events);
  const projectChanged = JSON.stringify(before.project) !== JSON.stringify(after.project);
  if (count(tasks) + count(links) + count(events) + (projectChanged ? 1 : 0) > MAX_CHANGED_ROWS) {
    return undefined;
  }
  const changes: RowChanges = {};
  const taskRows = await rowsOf(tasks, (ids) => tasksWithIds(manager, ids));
  const linkRows = await rowsOf(links, (ids) => linksWithIds(manager, ids));
  const eventRows = await rowsOf(events, (ids) => eventsWithIds(manager, ids));
  if (taskRows) changes.tasks = taskRows;
  if (linkRows) changes.dependencies = linkRows;
  if (eventRows) changes.events = eventRows;
  if (projectChanged) {
    const fields = await projectFieldsOf(manager, projectId);
    if (fields) changes.project = fields;
  }
  return changes;
}
