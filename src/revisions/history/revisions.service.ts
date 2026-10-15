import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RequestTransaction } from '../../database/request-transaction.js';
import { MAX_PAGE, PAGE_SIZE } from './dto/page-query.dto.js';
import { asRevisionDto, type RevisionDto } from './dto/revision.dto.js';
import { type BatchKind, Revision } from '../entities/revision.entity.js';
import { diffSnapshots, type Snapshot } from './revision-diff.js';
import { KEEP_REVISION_DAYS, UNDO_DEPTH } from '../history-limits.js';
import { ROWS } from '../rows.js';

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
 * before and after), listed newest first, and let go when old (prune). Restoring from it is
 * RestoreService.
 */
@Injectable()
export class RevisionsService {
  constructor(private readonly tx: RequestTransaction) {}

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
  async list(projectId: string, before?: string, limit = PAGE_SIZE): Promise<RevisionDto[]> {
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
}
