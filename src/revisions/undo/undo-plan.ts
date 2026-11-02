import type { BatchKind, Revision } from '../entities/revision.entity.js';
import {
  EVENT_FIELDS,
  type EventState,
  LINK_FIELDS,
  type LinkState,
  PROJECT_FIELDS,
  type ProjectState,
  type Snapshot,
  TASK_FIELDS,
  type TaskState,
} from '../history/revision-diff.js';

// The decisions undo and redo make, as plain functions of what was read (#56): which batch is on
// which stack, whether anything changed since, what a batch touches, whether the groups still
// hold. UndoService reads the rows, asks these, and writes. Tested on plain data in
// undo-plan.spec.ts.

/** One batch of a person's changes in a project, oldest first, as the stacks read them. */
export interface BatchRow {
  batchId: string;
  batchKind: BatchKind;
  /** For an undo or redo batch: the batch it undid or redid. */
  ofBatch: string | null;
  /** Making the project (not something to undo: it would mean deleting the project). */
  creation: boolean;
}

/**
 * The undo and redo stacks from a person's batches, oldest first: a change goes on the undo stack
 * and clears the redo stack; an undo moves its batch to the redo stack; a redo puts that batch
 * back (as the redo batch, which a next undo reverts). The last of each is what Undo / Redo do.
 */
export function undoStacks(batches: readonly BatchRow[]): { done: string[]; undone: string[] } {
  const done: string[] = [];
  let undone: string[] = [];
  const take = (stack: string[], id: string | null) => {
    const at = id ? stack.lastIndexOf(id) : -1;
    if (at >= 0) stack.splice(at, 1);
    return at >= 0;
  };
  for (const batch of batches) {
    if (batch.creation) continue;
    if (batch.batchKind === 'change') {
      done.push(batch.batchId);
      undone = [];
    } else if (batch.batchKind === 'undo') {
      if (take(done, batch.ofBatch)) undone.push(batch.ofBatch!);
    } else if (take(undone, batch.ofBatch)) {
      done.push(batch.batchId);
    }
  }
  return { done, undone };
}

/** A row as the history keeps it, any kind. */
export type Row = Partial<TaskState & EventState & ProjectState & LinkState> & {
  id?: string;
  name?: string;
};

/** One revision of a batch: what its row must be now, and what it becomes. */
export interface Step {
  revision: Revision;
  expected: Row | null;
  wanted: Row | null;
}

/** The steps of undoing (back to `before`) or redoing (on to `after`) a batch's revisions. */
export const stepsOf = (revisions: readonly Revision[], direction: 'undo' | 'redo'): Step[] =>
  revisions.map((revision) => ({
    revision,
    expected: (direction === 'undo' ? revision.after : revision.before) as Row | null,
    wanted: (direction === 'undo' ? revision.before : revision.after) as Row | null,
  }));

/** The row a revision is about, as it is now (null: gone). */
export const currentOf = (now: Snapshot, revision: Revision): Row | null => {
  if (revision.entityType === 'task') return now.tasks.get(revision.entityId) ?? null;
  if (revision.entityType === 'event') return now.events.get(revision.entityId) ?? null;
  if (revision.entityType === 'link') {
    return (now.links.find((link) => link.id === revision.entityId) as Row | undefined) ?? null;
  }
  return now.project;
};

const FIELDS: Record<Revision['entityType'], readonly string[]> = {
  task: TASK_FIELDS,
  event: EVENT_FIELDS,
  project: PROJECT_FIELDS,
  link: LINK_FIELDS,
};

/**
 * Whether a row is as expected: both gone, or the same in every field the history follows. A
 * group's progress is left out: it is the average of its tasks (#80), so it moves whenever anyone
 * changes one of them, and is set again after the undo anyway.
 */
export function matches(type: Revision['entityType'], expected: Row | null, current: Row | null) {
  if (!expected || !current) return !expected && !current;
  const derived = type === 'task' && expected.type === 'group' && current.type === 'group';
  return FIELDS[type].every(
    (field) =>
      (derived && field === 'progress') ||
      (expected as Record<string, unknown>)[field] === (current as Record<string, unknown>)[field],
  );
}

/**
 * Why the steps can't run on the project as it is now, or null when they can:
 * - a row they change is no longer as the batch left it (someone changed it since);
 * - a task they would remove has tasks or links others added since (they would go with it).
 */
export function refusalOf(
  steps: readonly Step[],
  now: Snapshot,
  direction: 'undo' | 'redo',
): string | null {
  const changed = steps.find(
    ({ revision, expected }) => !matches(revision.entityType, expected, currentOf(now, revision)),
  );
  if (changed) {
    const name = (currentOf(now, changed.revision) ?? changed.expected)?.name;
    return `Can't ${direction}: ${name ? `“${name}”` : 'something it changed'} was changed since`;
  }
  const inBatch = new Set(steps.map(({ revision }) => revision.entityId));
  for (const { revision, wanted } of steps) {
    if (revision.entityType !== 'task' || wanted) continue;
    const id = revision.entityId;
    const theirs =
      [...now.tasks.values()].some((task) => task.parentId === id && !inBatch.has(task.id)) ||
      now.links.some(
        (link) =>
          (link.fromTaskId === id || link.toTaskId === id) && !(link.id && inBatch.has(link.id)),
      );
    if (theirs) {
      const name = now.tasks.get(id)?.name;
      return `Can't ${direction}: ${name ? `“${name}”` : 'a task it removes'} has tasks or links added since`;
    }
  }
  return null;
}

/** The groups and the list levels (a group's tasks, or the top level: null) the steps touch. */
export function touchedBy(steps: readonly Step[]) {
  const groups = new Set<string>();
  const levels = new Set<string | null>();
  for (const { revision, expected, wanted } of steps) {
    if (revision.entityType !== 'task') continue;
    for (const state of [expected, wanted] as (TaskState | null)[]) {
      if (!state) continue;
      if (state.parentId) groups.add(state.parentId);
      levels.add(state.parentId);
    }
    if ((wanted as TaskState | null)?.type === 'group') groups.add(revision.entityId);
  }
  return { groups, levels };
}

/**
 * Whether the project's tasks form a tree: every task's group is a group of the project, and no
 * group is inside itself.
 */
export function treeHolds(rows: readonly { id: string; parentId: string | null; type: string }[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (!row.parentId) continue;
    if (byId.get(row.parentId)?.type !== 'group') return false;
    // Up the chain: back at this task means a loop. (Bounded: a chain can't be longer than this.)
    let at: string | null = row.parentId;
    for (let steps = 0; at; steps++) {
      if (at === row.id || steps > rows.length) return false;
      at = byId.get(at)?.parentId ?? null;
    }
  }
  return true;
}

/** What a change did, without the "Undo: " / "Redo: " an undone or redone batch is noted with. */
export const plain = (summary: string) => summary.replace(/^(Undo|Redo): /, '');
