import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RequestTransaction } from '../database/request-transaction.js';
import { DependencyService } from '../dependencies/dependency.service.js';
import { EventsService } from '../events/events.service.js';
import { roleIn } from '../members/membership.js';
import { ProjectsService } from '../projects/projects.service.js';
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
import { KEEP_REVISION_DAYS, UNDO_DEPTH } from './history-limits.js';
import { ROWS } from './rows.js';

/** A task's type, as TaskService takes it. */
type TaskType = Parameters<TaskService['changeType']>[1];

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
  ) {}

  private get revisionRepo() {
    return this.tx.repo(Revision);
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
        await ROWS[draft.entityType].setVersion(
          manager,
          draft.entityId,
          versions.get(draft.entityId)!,
        );
      }
    });
    return versions;
  }

  /**
   * Lets a project's old revisions go (#54), keeping what still reads them:
   * - anything newer than KEEP_REVISION_DAYS: an open tab may still save from a version they made,
   *   and the conflict check (#21) needs them to see who changed what since;
   * - each person's UNDO_DEPTH newest batches, and the batches those undo or redo (`ofBatch`): what
   *   undo and redo read (UndoService);
   * - the newest revision of every row that is still there (its newest is not its deletion): the
   *   next one is numbered on from it (record). A row that is gone keeps nothing past the rules
   *   above, so no history is kept forever. Every deletion is recorded (a write can't succeed
   *   without its history), so the history alone tells which rows are gone.
   * Older history is let go: the project's versions keep the long view. Answers how many went.
   */
  async prune(
    projectId: string,
    keep = { days: KEEP_REVISION_DAYS, batches: UNDO_DEPTH },
  ): Promise<number> {
    const [, deleted] = await this.tx.manager.query<[unknown, number]>(
      `WITH "batches" AS (
         SELECT "batchId", "ofBatch",
                row_number() OVER (PARTITION BY "changedById" ORDER BY MIN("createdAt") DESC) AS "rank"
           FROM "revisions" WHERE "projectId" = $1
          GROUP BY "batchId", "ofBatch", "changedById"),
       "kept" AS (
         SELECT "batchId" FROM "batches" WHERE "rank" <= $3
         UNION SELECT "ofBatch" FROM "batches" WHERE "rank" <= $3 AND "ofBatch" IS NOT NULL)
       DELETE FROM "revisions" r
        WHERE r."projectId" = $1
          AND r."createdAt" < now() - make_interval(days => $2)
          AND r."batchId" NOT IN (SELECT "batchId" FROM "kept")
          AND (r."action" = 'delete'
               OR EXISTS (SELECT 1 FROM "revisions" n
                           WHERE n."entityId" = r."entityId" AND n."version" > r."version"))`,
      [projectId, keep.days, keep.batches],
    );
    return deleted;
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
    const current = await this.tasks.find(state.id);
    // The group it was in, if it is still there to hold it (and wouldn't hold its own group).
    let parentId = state.parentId;
    if (parentId && !(await this.tasks.canHold(projectId, parentId, state.id))) {
      skipped.push(
        'its group (gone, no longer a group, or in a loop of groups): it stays where it is',
      );
      parentId = current ? current.parentId : null;
    }

    if (!current) {
      // Deleted since: made again, with the same id (so its history goes on).
      await this.tasks.recreate({
        id: state.id,
        projectId,
        name: state.name,
        description: state.description ?? undefined,
        type: state.type as TaskType,
        priority: state.priority as 'medium',
        startDate: state.startDate as unknown as Date,
        endDate: (state.type === 'milestone' ? state.startDate : state.endDate) as unknown as Date,
        progress: state.progress,
        color: state.color,
        order: state.order,
        parentId,
      });
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
      if ((await this.tasks.childCount(current.id)) > 0) {
        throw new BadRequestException(
          'This group has tasks in it now. Move them out before restoring it as a task',
        );
      }
    }
    // A refused step (a link may not allow it in its group) undoes the whole restore: it is one
    // transaction, so the task stays as it was.
    if (current.parentId !== parentId) await this.tasks.setParent(current.id, parentId);
    if (current.type !== state.type) {
      await this.tasks.changeType(current.id, state.type as TaskType);
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
    if (await this.events.exists(state.id)) {
      await this.events.update(state.id, fields);
    } else {
      await this.events.recreate(state.id, projectId, fields);
    }
  }
}
