import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { roleIn } from '../projects/project-access.js';
import { TaskScheduler } from '../scheduling/task-scheduler.service.js';
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
import { setTaskParent, writeEvent, writeLink, writeTask } from './revision-write.js';

/** How far back the undo / redo stacks are read (batches of one person in one project). */
const STACK_DEPTH = 200;

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
    @InjectRepository(Revision)
    private readonly revisionRepo: Repository<Revision>,
    private readonly db: DataSource,
    private readonly scheduler: TaskScheduler,
  ) {}

  async state(
    projectId: string,
    userId: string,
  ): Promise<{ undo: UndoStep | null; redo: UndoStep | null }> {
    const { done, undone } = await this.stacks(projectId, userId);
    const [undo, redo] = await Promise.all([this.step(done.at(-1)), this.step(undone.at(-1))]);
    return { undo, redo };
  }

  /** Reverts the person's last change. Answers what it undid (for the history: `of` the batch). */
  async undo(projectId: string, userId: string): Promise<UndoStep> {
    const { done } = await this.stacks(projectId, userId);
    const batchId = done.at(-1);
    if (!batchId) throw new ConflictException('Nothing to undo');
    return this.apply(projectId, userId, batchId, 'undo');
  }

  /** Puts back what the person's last undo reverted. */
  async redo(projectId: string, userId: string): Promise<UndoStep> {
    const { undone } = await this.stacks(projectId, userId);
    const batchId = undone.at(-1);
    if (!batchId) throw new ConflictException('Nothing to redo');
    return this.apply(projectId, userId, batchId, 'redo');
  }

  private async stacks(projectId: string, userId: string) {
    const batches = await this.db.query<
      { batchId: string; batchKind: BatchKind; ofBatch: string | null; creation: boolean }[]
    >(
      `SELECT "batchId", "batchKind", "ofBatch", "creation" FROM (
         SELECT "batchId", "batchKind", "ofBatch", MIN("createdAt") AS "at",
                bool_and("entityType" = 'project' AND "action" = 'create') AS "creation"
           FROM "revisions" WHERE "projectId" = $1 AND "changedById" = $2
          GROUP BY "batchId", "batchKind", "ofBatch"
          ORDER BY "at" DESC LIMIT $3) recent
        ORDER BY "at" ASC`,
      [projectId, userId, STACK_DEPTH],
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
  ): Promise<UndoStep> {
    const revisions = await this.revisionRepo.find({ where: { batchId, projectId } });
    if (revisions.length === 0) throw new NotFoundException('Not found');
    if (
      revisions.some((revision) => revision.entityType === 'project') &&
      (await roleIn(this.db, projectId, userId)) !== 'owner'
    ) {
      throw new ForbiddenException('Only an owner of this project can do this');
    }
    // What each row must be now, and what it becomes.
    const steps = revisions.map((revision) => ({
      revision,
      expected: (direction === 'undo' ? revision.after : revision.before) as Row | null,
      wanted: (direction === 'undo' ? revision.before : revision.after) as Row | null,
    }));

    const now = await loadSnapshot(this.db.manager, projectId);
    const changed = steps.find(
      ({ revision, expected }) => !matches(revision.entityType, expected, currentOf(now, revision)),
    );
    if (changed) {
      const name = (currentOf(now, changed.revision) ?? changed.expected)?.name;
      throw new ConflictException(
        `Can't ${direction}: ${name ? `“${name}”` : 'something it changed'} was changed since`,
      );
    }

    await this.db.transaction(async (manager) => {
      for (const { revision, wanted } of steps) {
        if (revision.entityType === 'project' && wanted) {
          const project = wanted as ProjectState;
          await manager.query(
            `UPDATE "projects" SET "name" = $2, "description" = $3, "archived" = $4 WHERE "id" = $1`,
            [projectId, project.name, project.description, project.archived],
          );
        }
      }
      // Removed first (a task's links go with it), then written, then groups and links.
      for (const { revision, wanted } of steps) {
        if (wanted) continue;
        const table = TABLES[revision.entityType];
        if (table) {
          await manager.query(`DELETE FROM "${table}" WHERE "id" = $1`, [revision.entityId]);
        }
      }
      const tasks = steps.flatMap(({ revision, wanted }) =>
        revision.entityType === 'task' && wanted ? [wanted as TaskState] : [],
      );
      for (const task of tasks) await writeTask(manager, projectId, task);
      for (const task of tasks) await setTaskParent(manager, task.id, task.parentId);
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
    });
    // The groups it touched fit their tasks again: a task someone else put in a group since is
    // still in it, and the group must cover it (a group is the span of its tasks).
    const groups = new Set<string>();
    for (const { revision, expected, wanted } of steps) {
      if (revision.entityType !== 'task') continue;
      for (const state of [expected, wanted] as (TaskState | null)[]) {
        if (state?.parentId) groups.add(state.parentId);
      }
      if ((wanted as TaskState | null)?.type === 'group') groups.add(revision.entityId);
    }
    for (const groupId of groups) {
      const there = await this.db.query<unknown[]>(
        `SELECT 1 FROM "tasks" WHERE "id" = $1 AND "type" = 'group'`,
        [groupId],
      );
      if (there.length > 0) await this.scheduler.refitGroup(projectId, groupId);
    }
    const main = steps.find((step) => step.revision.primary) ?? steps[0]!;
    return { batchId, summary: plain(main.revision.summary) };
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

/** Where each kind of row is stored (the project itself is never deleted by an undo). */
const TABLES: Record<Revision['entityType'], string | null> = {
  task: 'tasks',
  event: 'events',
  link: 'task_dependencies',
  project: null,
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
