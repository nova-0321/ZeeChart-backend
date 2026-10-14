import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RequestTransaction } from '../database/request-transaction.js';
import { DependencyService } from '../dependencies/dependency.service.js';
import { ProjectEvent } from '../events/entities/project-event.entity.js';
import { EventsService } from '../events/events.service.js';
import { roleIn } from '../projects/project-access.js';
import { ProjectsService } from '../projects/projects.service.js';
import { TaskScheduler } from '../scheduling/task-scheduler.service.js';
import { Task } from '../tasks/entities/task.entity.js';
import { TaskService } from '../tasks/task.service.js';
import type { RestoreResultDto as RestoreResult } from './dto/restore-result.dto.js';
import { asRevisionDto, type RevisionDto } from './dto/revision.dto.js';
import { type BatchKind, Revision } from './entities/revision.entity.js';
import {
  diffSnapshots,
  type EventState,
  type ProjectState,
  type Snapshot,
  stateOf,
  type TaskState,
} from './revision-diff.js';

/** Where each kind of row is stored. */
export const TABLES = {
  project: 'projects',
  task: 'tasks',
  event: 'events',
  link: 'task_dependencies',
} as const;

/** At most this many revisions in one answer of the history. */
export const MAX_PAGE = 100;

export interface RecordOptions {
  userId: string | null;
  /** The row the request was about (see diffSnapshots). */
  target?: string;
  /** An undo or redo of another batch (see UndoService); a plain change when left out. */
  batch?: { kind: BatchKind; of: string };
  /** Tasks an undo or redo put back at a place in their list (see diffSnapshots). */
  placed?: ReadonlySet<string>;
  /** Said first in the summary of `target`'s revision, or of every one with no target. */
  note?: string;
}

/**
 * The history of a project: written after every change (RevisionInterceptor gives the snapshots
 * before and after), listed newest first, and restored from. A restore goes through the same
 * services as any change, so the same rules hold (groups cover their tasks, links push tasks), and
 * is itself recorded as a change.
 */
@Injectable()
export class RevisionsService {
  constructor(
    private readonly tx: RequestTransaction,
    private readonly tasks: TaskService,
    private readonly events: EventsService,
    private readonly projects: ProjectsService,
    private readonly links: DependencyService,
    private readonly scheduler: TaskScheduler,
  ) {}

  private get revisionRepo() {
    return this.tx.repo(Revision);
  }

  private get taskRepo() {
    return this.tx.repo(Task);
  }

  private get eventRepo() {
    return this.tx.repo(ProjectEvent);
  }

  /**
   * Saves one revision per row that differs between the snapshots, numbered on from each entity's
   * last version. Numbering waits for any other numbering of the project (a lock), so two at once
   * can't take the same number.
   */
  async record(
    projectId: string,
    before: Snapshot,
    after: Snapshot,
    options: RecordOptions,
  ): Promise<Map<string, number>> {
    // The new version of each row that changed (what the answer to the request carries).
    const versions = new Map<string, number>();
    // The project is gone (deleted): so is its history.
    if (!after.project) return versions;
    const drafts = diffSnapshots(before, after, options.target, options.placed);
    if (drafts.length === 0) return versions;
    const batchId = randomUUID();
    await this.tx.manager.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`revisions:${projectId}`]);
      const last = await manager.query<{ entityId: string; version: number }[]>(
        `SELECT "entityId", MAX("version")::int AS "version" FROM "revisions"
          WHERE "entityId" = ANY($1) GROUP BY "entityId"`,
        [drafts.map((draft) => draft.entityId)],
      );
      const versionOf = new Map(last.map((row) => [row.entityId, row.version]));
      for (const draft of drafts) {
        versions.set(draft.entityId, (versionOf.get(draft.entityId) ?? 0) + 1);
      }
      await manager.save(
        drafts.map((draft) =>
          manager.create(Revision, {
            projectId,
            entityType: draft.entityType,
            entityId: draft.entityId,
            version: versions.get(draft.entityId)!,
            action: draft.action,
            changedById: options.userId,
            summary:
              // A note about one row goes on its revision; with no row named, on all of them.
              options.note && (options.target === undefined || draft.entityId === options.target)
                ? `${options.note}: ${draft.summary}`
                : draft.summary,
            before: draft.before as Record<string, unknown> | null,
            after: draft.after as Record<string, unknown> | null,
            batchId,
            primary: draft.primary ?? false,
            batchKind: options.batch?.kind ?? 'change',
            ofBatch: options.batch?.of ?? null,
          }),
        ),
      );
      // Each row that is still there carries its new version (the same number as its revision).
      for (const draft of drafts) {
        if (!draft.after) continue;
        await manager.query(
          `UPDATE "${TABLES[draft.entityType]}" SET "version" = $2 WHERE "id" = $1`,
          [draft.entityId, versions.get(draft.entityId)],
        );
      }
    });
    return versions;
  }

  /**
   * The project's history, newest first. `before`: the id of the last revision of the previous
   * page; the page goes on after it. By id, not by time: the revisions of one request share their
   * time to the microsecond, and a page may end in the middle of them.
   */
  async list(projectId: string, before?: string, limit = 50): Promise<RevisionDto[]> {
    const query = this.revisionRepo
      .createQueryBuilder('revision')
      .leftJoinAndSelect('revision.changedBy', 'changedBy')
      .where('revision.projectId = :projectId', { projectId })
      .orderBy('revision.createdAt', 'DESC')
      .addOrderBy('revision.id', 'DESC')
      .limit(Math.min(Math.max(limit, 1), MAX_PAGE));
    if (before) {
      query.andWhere(
        `(revision.createdAt, revision.id) < (
           SELECT cursor."createdAt", cursor."id" FROM "revisions" cursor
            WHERE cursor."id" = :before AND cursor."projectId" = :projectId)`,
        { before },
      );
    }
    return (await query.getMany()).map(asRevisionDto);
  }

  /**
   * Puts an entity back the way it was right after the revision (for a deletion: right before it,
   * so it comes back). A project's own revisions are its owners' to restore. 400 when the state
   * can't be put back as it stands now (see the messages); then nothing of it is put back.
   */
  restore(id: string, userId: string): Promise<RestoreResult> {
    return this.tx.run(() => this.restoreNow(id, userId));
  }

  private async restoreNow(id: string, userId: string): Promise<RestoreResult> {
    const revision = await this.revisionRepo.findOneBy({ id });
    if (!revision) throw new NotFoundException('Not found');
    const state = stateOf(revision);
    if (!state) throw new BadRequestException('This revision has nothing to restore');
    const result: RestoreResult = {
      entityType: revision.entityType,
      entityId: revision.entityId,
      version: revision.version,
      skipped: [],
    };
    switch (revision.entityType) {
      case 'task':
        await this.restoreTask(revision.projectId, state as TaskState, result.skipped);
        break;
      case 'event':
        await this.restoreEvent(revision.projectId, state as EventState);
        break;
      case 'link':
        // A link comes back with its task (restoring a deleted task), with undo, or with a version.
        throw new BadRequestException('A link is restored with its task, or with undo');
      case 'project': {
        if ((await roleIn(this.tx.manager, revision.projectId, userId)) !== 'owner') {
          throw new ForbiddenException('Only an owner of this project can do this');
        }
        const project = state as ProjectState;
        await this.projects.update(
          revision.projectId,
          {
            name: project.name,
            // null clears it (the project had none then).
            description: project.description as string | undefined,
            archived: project.archived,
          },
          userId,
        );
        break;
      }
    }
    return result;
  }

  private async restoreTask(projectId: string, state: TaskState, skipped: string[]) {
    const current = await this.taskRepo.findOneBy({ id: state.id });
    // The group it was in, if it is still there to hold it (and wouldn't hold its own group).
    let parentId = state.parentId;
    if (parentId && !(await this.canHold(projectId, parentId, state.id))) {
      skipped.push(
        'its group (gone, no longer a group, or in a loop of groups): it stays where it is',
      );
      parentId = current ? current.parentId : null;
    }

    if (!current) {
      // Deleted since: made again, with the same id (so its history goes on).
      const task = this.taskRepo.create({
        id: state.id,
        projectId,
        name: state.name,
        description: state.description ?? undefined,
        type: state.type,
        priority: state.priority,
        startDate: state.startDate as unknown as Date,
        endDate: (state.type === 'milestone' ? state.startDate : state.endDate) as unknown as Date,
        progress: state.progress,
        color: state.color,
        order: state.order,
        parentId,
      });
      if (parentId) await this.scheduler.saveAttached(task);
      else await this.taskRepo.save(task);
      // Its links, where the task at the other end is still there (the same rules as a new link).
      for (const link of state.links ?? []) {
        try {
          await this.links.create({
            fromTaskId: link.fromTaskId,
            toTaskId: link.toTaskId,
            type: link.type as 'FS',
            lagDays: link.lagDays,
          });
        } catch {
          skipped.push('a link (the task at its other end is gone, or the link no longer fits)');
        }
      }
      return;
    }

    // Still there: checked first, so nothing is half put back.
    if (current.type === 'group' && state.type !== 'group') {
      const children = await this.taskRepo.countBy({ parentId: current.id });
      if (children > 0) {
        throw new BadRequestException(
          'This group has tasks in it now. Move them out before restoring it as a task',
        );
      }
    }
    // A refused step (a link may not allow it in its group) undoes the whole restore: it is one
    // transaction, so the task stays as it was.
    if (current.parentId !== parentId) await this.tasks.setParent(current.id, parentId);
    if (current.type !== state.type) {
      await this.tasks.changeType(current.id, state.type as Task['type']);
    }
    await this.tasks.update(current.id, {
      name: state.name,
      // null clears it (it had none then).
      description: state.description as string | undefined,
      priority: state.priority as 'medium',
      progress: state.progress,
      color: state.color,
      startDate: state.startDate as unknown as Date,
      endDate: state.endDate as unknown as Date,
    });
  }

  private async restoreEvent(projectId: string, state: EventState) {
    const fields = {
      name: state.name,
      color: state.color,
      startDate: state.startDate,
      endDate: state.endDate,
    };
    if (await this.eventRepo.existsBy({ id: state.id })) {
      await this.events.update(state.id, fields);
    } else {
      await this.eventRepo.save(this.eventRepo.create({ id: state.id, projectId, ...fields }));
    }
  }

  /**
   * Whether `parentId` is a group of the project that may hold `taskId` (not inside it). A group
   * whose chain loops (a loop already in the data) can't: the task stays where it is.
   */
  private async canHold(projectId: string, parentId: string, taskId: string) {
    let node = await this.taskRepo.findOneBy({ id: parentId });
    if (!node || node.projectId !== projectId || node.type !== 'group') return false;
    const seen = new Set<string>();
    while (node) {
      if (node.id === taskId || seen.has(node.id)) return false;
      seen.add(node.id);
      node = node.parentId ? await this.taskRepo.findOneBy({ id: node.parentId }) : null;
    }
    return true;
  }
}
