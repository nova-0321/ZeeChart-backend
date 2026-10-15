import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Request } from 'express';
import type { EntityManager } from 'typeorm';
import { accountNameOf } from '../../auth/accounts.js';
import type { RealtimeEntity } from '../../realtime/realtime.types.js';
import {
  EVENT_FIELDS,
  LINK_FIELDS,
  PROJECT_FIELDS,
  type RevisionEntity,
  type Snapshot,
  TASK_FIELDS,
} from './revision-diff.js';
import { ROWS } from '../rows.js';

// Conflict checks (#21; see docs/conflicts.md). A write may say which version of the row it was
// made from (`If-Match: <version>`). It is refused (409) only when someone else changed, since that
// version, one of the fields this write changes: a change to other fields, or by yourself (a quick
// second save from the same screen), or one the server made because of another (a group stretched
// over its tasks) to other fields, is not a conflict, and the write goes through over it.

/** What the write is about and what it changes, or null: a route without a row to check. */
export interface Target {
  entityType: RevisionEntity;
  id: string;
  /** The fields it changes; every field for a deletion. */
  fields: readonly string[];
}

const ALL: Record<RevisionEntity, readonly string[]> = {
  task: [...TASK_FIELDS, 'order'],
  event: EVENT_FIELDS,
  project: PROJECT_FIELDS,
  link: LINK_FIELDS,
};
const ENTITY: Partial<Record<RealtimeEntity, RevisionEntity>> = {
  task: 'task',
  event: 'event',
  project: 'project',
  dependency: 'link',
};

/** The version in `If-Match` ("3", "\"3\"" or W/"3"); undefined when there is none. */
export function versionIn(request: Request): number | undefined {
  const header = request.headers['if-match'];
  if (header === undefined) return undefined;
  const match = /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(String(header));
  if (!match) throw new BadRequestException('If-Match must be the version you saw, like 3');
  return Number(match[1]);
}

/** The row a write route changes and the fields it changes (null: nothing to check). */
export function targetOf(entity: RealtimeEntity, request: Request): Target | null {
  const entityType = ENTITY[entity];
  const id = request.params.id;
  if (!entityType || typeof id !== 'string') return null;
  const route = String((request.route as { path?: string } | undefined)?.path ?? '');
  if (request.method === 'DELETE') return { entityType, id, fields: ALL[entityType] };
  if (request.method !== 'PATCH') return null;
  if (route.endsWith('/parent')) return { entityType, id, fields: ['parentId'] };
  if (route.endsWith('/move')) return { entityType, id, fields: ['parentId', 'order'] };
  if (route.endsWith('/type')) return { entityType, id, fields: ['type'] };
  if (route.endsWith('/archive') || route.endsWith('/reopen')) {
    return { entityType, id, fields: ['archived'] };
  }
  const sent = Object.keys((request.body as Record<string, unknown> | undefined) ?? {});
  return { entityType, id, fields: ALL[entityType].filter((field) => sent.includes(field)) };
}

const LABELS: Record<string, string> = {
  name: 'the name',
  description: 'the description',
  type: 'the type',
  priority: 'the priority',
  startDate: 'the dates',
  endDate: 'the dates',
  progress: 'the progress',
  color: 'the color',
  parentId: 'the group',
  order: 'the place in the list',
  archived: 'whether it is archived',
  lagDays: 'the lag',
  fromTaskId: 'the tasks it links',
  toTaskId: 'the tasks it links',
};

/** The row as it is now (from the snapshot taken before the write), or null. */
function currentOf(now: Snapshot, target: Target): Record<string, unknown> | null {
  const row =
    target.entityType === 'task'
      ? now.tasks.get(target.id)
      : target.entityType === 'event'
        ? now.events.get(target.id)
        : target.entityType === 'project'
          ? now.project
          : now.links.find((link) => link.id === target.id);
  return (row as Record<string, unknown> | null | undefined) ?? null;
}

/**
 * Throws a 409 when someone other than `userId` changed, after `seen`, one of the fields `target`
 * changes. The answer says who, which fields, and carries the row as it is now with its version.
 */
export async function assertNoConflict(
  db: EntityManager,
  now: Snapshot,
  target: Target,
  seen: number,
  userId: string,
) {
  const later = await db.query<
    {
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      version: number;
      changedById: string | null;
    }[]
  >(
    `SELECT r."before", r."after", r."version", r."changedById"
       FROM "revisions" r
      WHERE r."entityId" = $1 AND r."version" > $2
        AND r."changedById" IS DISTINCT FROM $3
      ORDER BY r."version" DESC`,
    [target.id, seen, userId],
  );
  for (const revision of later) {
    const fields = target.fields.filter(
      (field) => revision.before?.[field] !== revision.after?.[field],
    );
    if (fields.length === 0) continue;
    const current = currentOf(now, target);
    // Their name, asked of the accounts (auth); a deleted account is "Someone".
    const who =
      (revision.changedById ? await accountNameOf(db, revision.changedById) : null) ?? 'Someone';
    const what = [...new Set(fields.map((field) => LABELS[field] ?? field))].join(' and ');
    const name =
      target.entityType === 'link'
        ? 'the link'
        : typeof current?.name === 'string'
          ? `“${current.name}”`
          : 'it';
    const version = await ROWS[target.entityType].versionOf(db, target.id);
    throw new ConflictException({
      message: `${who} changed ${what} of ${name} meanwhile. Your change wasn't saved`,
      details: {
        conflict: true,
        fields,
        changedBy: revision.changedById ? { id: revision.changedById, name: who } : null,
        // What is there now, and its version: send that version to save over it.
        current,
        version,
      },
    });
  }
}
