import type { EntityManager } from 'typeorm';
import { linksOf } from '../dependencies/link-rows.js';
import { eventRowsOf } from '../events/event-rows.js';
import { projectRowOf } from '../projects/project-rows.js';
import { taskRowsOf } from '../tasks/task-rows.js';
import type { Snapshot } from './history/revision-diff.js';

// A project as stored right now: its row, tasks, events and links, in the plain shape revisions
// keep (dates as "YYYY-MM-DD"). Each part is read by the domain that owns it (#55), with plain
// queries: what is in the database, nothing cached.

export async function loadSnapshot(db: EntityManager, projectId: string): Promise<Snapshot> {
  // One after the other: inside a transaction they share one connection, which takes one query at
  // a time (pg deprecates sending the next before the last is answered).
  const project = await projectRowOf(db, projectId);
  const tasks = await taskRowsOf(db, projectId);
  const events = await eventRowsOf(db, projectId);
  const links = await linksOf(db, projectId);
  return {
    project,
    tasks: new Map(tasks.map((task) => [task.id, task])),
    events: new Map(events.map((event) => [event.id, event])),
    links,
  };
}
