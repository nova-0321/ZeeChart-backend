import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { DataSource } from 'typeorm';
import type { AuthedRequest } from '../auth/auth.guard.js';
import { ProjectWriteLock } from '../database/project-write-lock.js';
import { BROADCAST, type BroadcastOptions } from '../realtime/broadcast.decorator.js';
import type { ChangedRowsRequest, RowChanges } from '../realtime/realtime.types.js';
import type { Snapshot } from './history/revision-diff.js';
import { assertNoConflict, targetOf, versionIn } from './history/conflicts.js';
import { loadSnapshot } from './revision-state.js';
import { changedRows } from './row-changes.js';
import { RevisionsService } from './history/revisions.service.js';
import { VersionsService } from './versions/versions.service.js';

/** What a route may add to its revisions (the restore route says what it restored). */
export interface RevisionRequest extends AuthedRequest {
  revisionNote?: string;
  revisionTarget?: string;
  /** The change is about the whole project (a version restored): no one row, the note on all. */
  revisionWholeProject?: boolean;
  /** The request undid or redid another batch (UndoService). */
  revisionBatch?: { kind: 'undo' | 'redo'; of: string };
  /** Tasks the undo or redo put back at a place in their list (their moves are recorded). */
  revisionPlaced?: ReadonlySet<string>;
}

/**
 * Writes the history of every change to a project, its tasks and its events. It acts on the write
 * routes that tell others of a change (@Broadcast: they all know their project), except members
 * (not part of the history): it reads the project before the route runs and again after it
 * succeeded, and records what differs (RevisionsService.record). So a change the route made to
 * other rows too (a group stretched, a linked task pushed) is in the history as well, with no
 * route having to remember it.
 *
 * The whole write is one transaction holding the project's lock (ProjectWriteLock): the conflict
 * check, the route's changes and their history are saved together or not at all. A change that
 * can't be recorded is not saved either (the client gets an error), so every change has its
 * history, its new version and its undo. Writes to one project run one after another, on every
 * server instance.
 */
@Injectable()
export class RevisionInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RevisionInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly db: DataSource,
    private readonly lock: ProjectWriteLock,
    private readonly revisions: RevisionsService,
    private readonly versions: VersionsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<BroadcastOptions | undefined>(
      BROADCAST,
      context.getHandler(),
    );
    if (
      !options ||
      options.entity === 'member' ||
      options.entity === 'invitation' ||
      context.getType() !== 'http'
    ) {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest<RevisionRequest>();
    return from(this.run(options, request, next));
  }

  private async run(options: BroadcastOptions, request: RevisionRequest, next: CallHandler) {
    const projectId = await options.project(request, this.db).catch(() => undefined);
    const handle = () => lastValueFrom(next.handle(), { defaultValue: undefined });
    if (!projectId) return handle();
    // Checked first, outside the lock: a malformed header is the request's own mistake.
    const seen = versionIn(request);
    const target = seen === undefined ? null : targetOf(options.entity, request);
    let after: Snapshot | null = null;
    const body = await this.lock.run(projectId, async (manager) => {
      const before = await loadSnapshot(manager, projectId);
      // Made from an older version: refused when someone else changed what it changes (#21).
      if (seen !== undefined && target) {
        await assertNoConflict(manager, before, target, seen, request.userId);
      }
      const answer: unknown = await handle();
      after = await loadSnapshot(manager, projectId);
      const versions = await this.revisions.record(projectId, before, after, {
        userId: request.userId ?? null,
        target: request.revisionWholeProject
          ? undefined
          : (request.revisionTarget ?? text(request.params.id)),
        note: request.revisionNote,
        placed: request.revisionPlaced,
        batch: request.revisionBatch,
      });
      // The answer carries the versions the change gave (its rows were read before it).
      withVersions(answer, versions);
      // And the rows it changed (#75), for the change message (BroadcastInterceptor, around this
      // one) and for the tab that made it, which the message skips. Not for a restore (rows:
      // false): whoever has the project open loads it again.
      if (options.rows !== false) {
        const changes = await changedRows(manager, projectId, before, after);
        if (changes) {
          (request as RevisionRequest & ChangedRowsRequest).changedRows = changes;
          withChanges(answer, options, changes);
        }
      }
      return answer;
    });
    // Once it is saved, now and then a version of the whole project (VersionsService.autoSave): a
    // copy to go back to, so failing to make one only means one fewer, and fails nothing.
    const saved = after as Snapshot | null;
    if (saved) {
      const versioned = await this.versions
        .autoSave(projectId, saved, request.userId ?? null)
        .catch((error: unknown) => {
          this.logger.error(`Could not save a version of ${projectId}`, error as Error);
          return false;
        });
      // As often as a version is saved (every 10 minutes at most): the old history it now covers is
      // let go (RevisionsService.prune). Failing only means it is tried again next time.
      if (versioned) {
        await this.revisions
          .prune(projectId)
          .catch((error: unknown) =>
            this.logger.error(`Could not let old history of ${projectId} go`, error as Error),
          );
      }
    }
    return body;
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** The routes whose answer (the row they wrote) also carries every row the write changed. */
const ANSWERS_WITH_CHANGES: ReadonlySet<string> = new Set(['task', 'dependency', 'event']);

/**
 * Adds `changes` to the answer of a task, link or event create or update (one row, not a list): the
 * tab that made the change is not sent its message, and a date edit may have moved other rows.
 */
function withChanges(body: unknown, options: BroadcastOptions, changes: RowChanges) {
  if (!ANSWERS_WITH_CHANGES.has(options.entity) || options.action === 'delete') return;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
  (body as { changes?: RowChanges }).changes = changes;
}

/** Puts the new version on each row of an answer (one row or a list) that the change gave one. */
function withVersions(body: unknown, versions: Map<string, number>) {
  if (versions.size === 0 || body === null || typeof body !== 'object') return;
  for (const row of Array.isArray(body) ? body : [body]) {
    const item = row as { id?: unknown; version?: unknown } | null;
    if (item && typeof item.id === 'string' && 'version' in item && versions.has(item.id)) {
      item.version = versions.get(item.id);
    }
  }
}
