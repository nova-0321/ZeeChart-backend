import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { RequestTransaction } from '../database/request-transaction.js';
import { roleIn } from '../members/membership.js';
import { TaskScheduler } from '../tasks/scheduling/task-scheduler.service.js';
import type { UndoStepDto as UndoStep } from './dto/undo.dto.js';
import { type BatchKind, Revision } from './entities/revision.entity.js';
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
} from './revision-diff.js';
import { loadSnapshot } from './revision-state.js';
import { UNDO_DEPTH } from './history-limits.js';
import { ROWS } from './rows.js';
// Each kind of row is written back by the domain that owns it (#55).
import { writeLink } from '../dependencies/link-rows.js';
import { writeEvent } from '../events/event-rows.js';
import { ownersOwnProjectNamed } from '../members/membership.js';
import { writeProjectRow } from '../projects/project-rows.js';
import {
  parentIdOf,
  putAtPlace,
  renumberClashes,
  setTaskParent,
  taskTreeOf,
  writeTask,
} from '../tasks/task-rows.js';

/**
 * Undo and redo of one person's own changes in a project, whatever tab or device they made them
 * in, never someone else's. Built on the history (RevisionsService): each change is a batch with
 * the state before and after of everything it changed; undo writes the "before" states back, redo
 * the "after" ones, and either is itself recorded (batchKind undo / redo, ofBatch), so the stacks
 * survive a reload.
 *
 * The stacks, read from the person's batches in order: a change goes on the undo stack and clears
 * the redo stack; an undo moves its batch to the redo stack; a redo puts that batch back (as the
 * redo batch, which a next undo reverts).
 *
 * Nothing is overwritten that changed since: every row the batch changed must still be as the
 * batch left it (as an undo left it, for a redo), or it is refused (409) and nothing is written.
 */
@Injectable()
export class UndoService {
  constructor(
    private readonly tx: RequestTransaction,
    private readonly scheduler: TaskScheduler,
  ) {}

  private get revisionRepo() {
    return this.tx.repo(Revision);
  }

  async state(
    projectId: string,
    userId: string,
  ): Promise<{ undo: UndoStep | null; redo: UndoStep | null }> {
    const { done, undone } = await this.stacks(projectId, userId);
    const [undo, redo] = await Promise.all([this.step(done.at(-1)), this.step(undone.at(-1))]);
    return { undo, redo };
  }

  /** Reverts the person's last change. Answers what it undid (for the history: `of` the batch). */
  async undo(projectId: string, userId: string): Promise<Applied> {
    const { done } = await this.stacks(projectId, userId);
    const batchId = done.at(-1);
    if (!batchId) throw new ConflictException('Nothing to undo');
    return this.apply(projectId, userId, batchId, 'undo');
  }

  /** Puts back what the person's last undo reverted. */
  async redo(projectId: string, userId: string): Promise<Applied> {
    const { undone } = await this.stacks(projectId, userId);
    const batchId = undone.at(-1);
    if (!batchId) throw new ConflictException('Nothing to redo');
    return this.apply(projectId, userId, batchId, 'redo');
  }

  private async stacks(projectId: string, userId: string) {
    const batches = await this.tx.manager.query<
      { batchId: string; batchKind: BatchKind; ofBatch: string | null; creation: boolean }[]
    >(
      `SELECT "batchId", "batchKind", "ofBatch", "creation" FROM (
         SELECT "batchId", "batchKind", "ofBatch", MIN("createdAt") AS "at",
                bool_and("entityType" = 'project' AND "action" = 'create') AS "creation"
           FROM "revisions" WHERE "projectId" = $1 AND "changedById" = $2
          GROUP BY "batchId", "batchKind", "ofBatch"
          ORDER BY "at" DESC LIMIT $3) recent
        ORDER BY "at" ASC`,
      [projectId, userId, UNDO_DEPTH],
    );
    const done: string[] = [];
    let undone: string[] = [];
    const take = (stack: string[], id: string | null) => {
      const at = id ? stack.lastIndexOf(id) : -1;
      if (at >= 0) stack.splice(at, 1);
      return at >= 0;
    };
    for (const batch of batches) {
      // Making the project is not something to undo (it would mean deleting the project).
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

  private async step(batchId: string | undefined): Promise<UndoStep | null> {
    if (!batchId) return null;
    const main = await this.revisionRepo.findOne({
      where: { batchId },
      order: { primary: 'DESC', version: 'ASC' },
    });
    return main ? { batchId, summary: plain(main.summary) } : null;
  }

  private async apply(
    projectId: string,
    userId: string,
    batchId: string,
    direction: 'undo' | 'redo',
  ): Promise<Applied> {
    const revisions = await this.revisionRepo.find({ where: { batchId, projectId } });
    if (revisions.length === 0) throw new NotFoundException('Not found');
    if (
      revisions.some((revision) => revision.entityType === 'project') &&
      (await roleIn(this.tx.manager, projectId, userId)) !== 'owner'
    ) {
      throw new ForbiddenException('Only an owner of this project can do this');
    }
    // What each row must be now, and what it becomes.
    const steps = revisions.map((revision) => ({
      revision,
      expected: (direction === 'undo' ? revision.after : revision.before) as Row | null,
      wanted: (direction === 'undo' ? revision.before : revision.after) as Row | null,
    }));

    const now = await loadSnapshot(this.tx.manager, projectId);
    const changed = steps.find(
      ({ revision, expected }) => !matches(revision.entityType, expected, currentOf(now, revision)),
    );
    if (changed) {
      const name = (currentOf(now, changed.revision) ?? changed.expected)?.name;
      throw new ConflictException(
        `Can't ${direction}: ${name ? `“${name}”` : 'something it changed'} was changed since`,
      );
    }
    // A task it would remove that others have since put tasks in, or linked: removing it would
    // take their work with it (links go, tasks leave the group). Refused instead.
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
        throw new ConflictException(
          `Can't ${direction}: ${name ? `“${name}”` : 'a task it removes'} has tasks or links added since`,
        );
      }
    }

    // The groups and the list levels (a group's tasks, or the top level) it touches.
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

    const placed: string[] = [];
    await this.tx.manager.transaction(async (manager) => {
      for (const { revision, wanted } of steps) {
        if (revision.entityType === 'project' && wanted) {
          const project = wanted as ProjectState;
          // Its name back only if none of its owners has another project called that since.
          if (
            project.name !== now.project?.name &&
            (await ownersOwnProjectNamed(manager, projectId, project.name))
          ) {
            throw new ConflictException(
              `Can't ${direction}: an owner of this project has another one called “${project.name}” now`,
            );
          }
          await writeProjectRow(manager, {
            id: projectId,
            name: project.name,
            description: project.description,
            archived: project.archived,
          });
        }
      }
      // Removed first (a task's links go with it), then written, then groups and links.
      for (const { revision, wanted } of steps) {
        // The project itself is never deleted by an undo.
        if (wanted || revision.entityType === 'project') continue;
        await ROWS[revision.entityType].remove(manager, revision.entityId);
      }
      const tasks = steps.flatMap(({ revision, wanted }) =>
        revision.entityType === 'task' && wanted ? [wanted as TaskState] : [],
      );
      // A task's place in its list is only put back for a move this batch made (see place); any
      // other task keeps the place it has now, so a move someone made since is kept.
      for (const task of tasks) {
        const current = now.tasks.get(task.id);
        const order = task.place === undefined && current ? current.order : task.order;
        await writeTask(manager, projectId, { ...task, order });
      }
      for (const task of tasks) await setTaskParent(manager, task.id, task.parentId);
      // Its group gone meanwhile (setTaskParent leaves it at the top level then): refused, rather
      // than done differently from what it says.
      for (const task of tasks) {
        if (!task.parentId) continue;
        if ((await parentIdOf(manager, task.id)) !== task.parentId) {
          throw new ConflictException(`Can't ${direction}: the group of “${task.name}” is gone`);
        }
      }
      for (const { revision, wanted } of steps) {
        if (revision.entityType === 'event' && wanted) {
          await writeEvent(manager, projectId, wanted as EventState);
        }
        if (revision.entityType === 'link' && wanted) {
          await writeLink(manager, projectId, wanted as LinkState);
        }
      }
      // The links a task had when it was deleted (where the batch doesn't list them itself).
      for (const task of tasks) {
        for (const link of task.links ?? []) await writeLink(manager, projectId, link);
      }
      // Others may have changed the groups since: never leave a task under a missing or plain task,
      // or a group inside itself (that would also loop the scheduler forever).
      await assertTreeHolds(manager, projectId, direction);
      // A task this batch moved goes back to its place among the tasks there now (the others keep
      // their order); then any two on the same place (a task made again) are numbered again.
      for (const task of tasks) {
        if (task.place === undefined) continue;
        await putAtPlace(manager, projectId, task.id, task.parentId, task.place);
        placed.push(task.id);
      }
      await renumberClashes(manager, projectId, levels, new Set(tasks.map((task) => task.id)));
      // The groups it touched fit their tasks again (a task someone else put in a group since is
      // still in it, and the group must cover it), and links push what follows the written tasks.
      // In the same transaction: all of it, or none.
      await this.scheduler.settle(
        manager,
        projectId,
        groups,
        tasks.map((task) => task.id),
      );
    });
    const main = steps.find((step) => step.revision.primary) ?? steps[0]!;
    return { step: { batchId, summary: plain(main.revision.summary) }, placed };
  }
}

type Row = Partial<TaskState & EventState & ProjectState & LinkState> & {
  id?: string;
  name?: string;
};

const currentOf = (now: Snapshot, revision: Revision): Row | null => {
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

/** Whether a row is as expected: both gone, or the same in every field the history follows. */
function matches(type: Revision['entityType'], expected: Row | null, current: Row | null) {
  if (!expected || !current) return !expected && !current;
  return FIELDS[type].every(
    (field) =>
      (expected as Record<string, unknown>)[field] === (current as Record<string, unknown>)[field],
  );
}

/** What a change did, without the "Undo: " / "Redo: " an undone or redone batch is noted with. */
const plain = (summary: string) => summary.replace(/^(Undo|Redo): /, '');

/**
 * Every task's group is a group of the same project, and no group is inside itself. 409 (and
 * the caller's transaction is undone) otherwise.
 */
async function assertTreeHolds(
  manager: EntityManager,
  projectId: string,
  direction: 'undo' | 'redo',
) {
  const rows = await taskTreeOf(manager, projectId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const refuse = () => new ConflictException(`Can't ${direction}: the groups were changed since`);
  for (const row of rows) {
    if (!row.parentId) continue;
    if (byId.get(row.parentId)?.type !== 'group') throw refuse();
    // Up the chain: back at this task means a loop. (Bounded: a chain can't be longer than this.)
    let at: string | null = row.parentId;
    for (let steps = 0; at; steps++) {
      if (at === row.id || steps > rows.length) throw refuse();
      at = byId.get(at)?.parentId ?? null;
    }
  }
}

/** What an undo or redo did, and the tasks it put back at a place (their moves are recorded). */
export interface Applied {
  step: UndoStep;
  placed: string[];
}
