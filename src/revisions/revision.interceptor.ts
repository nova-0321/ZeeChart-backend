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
import type { Snapshot } from './revision-diff.js';
import { assertNoConflict, targetOf, versionIn } from './conflicts.js';
import { loadSnapshot } from './revision-state.js';
import { RevisionsService } from './revisions.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { VersionsService } from './versions.service.js';

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
 * Writes to one project run one after another, on every server instance (ProjectWriteLock), so the
 * snapshots of one request never take in another's changes. The history is written before the
 * answer goes out. Failing to write it never fails the change: it is logged.
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
    private readonly realtime: RealtimeService,
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
    return this.lock.run(projectId, async () => {
      const before = await this.snapshot(projectId);
      // Made from an older version: refused when someone else changed what it changes (#21).
      // Inside the lock, so nothing can change in between the check and the write.
      if (seen !== undefined && target && before) {
        await assertNoConflict(this.db, before, target, seen, request.userId);
      }
      let body: unknown;
      try {
        body = await handle();
      } catch (error) {
        // Refused part way (a restore whose last step wasn't allowed, a delete whose refit
        // failed): what it saved before that is still recorded, and the others told to reload.
        if (before) await this.recordFailed(projectId, before, request);
        throw error;
      }
      if (before) {
        const after = await this.snapshot(projectId);
        if (after) {
          const noted = request.revisionWholeProject
            ? undefined
            : (request.revisionTarget ?? text(request.params.id));
          const versions = await this.revisions
            .record(projectId, before, after, {
              userId: request.userId ?? null,
              target: noted,
              note: request.revisionNote,
              placed: request.revisionPlaced,
              batch: request.revisionBatch,
            })
            .catch((error: unknown) => {
              this.logger.error(`Could not record the history of ${projectId}`, error as Error);
              return new Map<string, number>();
            });
          // The answer carries the versions the change gave (its rows were read before it).
          withVersions(body, versions);
          // And now and then a version of the whole project (VersionsService.autoSave).
          await this.versions
            .autoSave(projectId, after, request.userId ?? null)
            .catch((error: unknown) =>
              this.logger.error(`Could not save a version of ${projectId}`, error as Error),
            );
        }
      }
      return body;
    });
  }

  /** The part of a refused request that was saved: in the history, and told to the others. */
  private async recordFailed(projectId: string, before: Snapshot, request: RevisionRequest) {
    try {
      const after = await this.snapshot(projectId);
      if (!after) return;
      const versions = await this.revisions.record(projectId, before, after, {
        userId: request.userId ?? null,
        target: request.revisionWholeProject ? undefined : text(request.params.id),
        note: request.revisionNote,
      });
      if (versions.size > 0) {
        this.realtime.notify({ projectId, entity: 'revision', action: 'resync' });
      }
    } catch (error) {
      this.logger.error(
        `Could not record what a refused request saved in ${projectId}`,
        error as Error,
      );
    }
  }

  private async snapshot(projectId: string): Promise<Snapshot | null> {
    try {
      return await loadSnapshot(this.db.manager, projectId);
    } catch (error) {
      this.logger.error(`Could not read ${projectId} for its history`, error as Error);
      return null;
    }
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

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
