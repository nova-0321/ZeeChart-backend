import { SetMetadata } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import type { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';
import type { RealtimeAction, RealtimeEntity } from './realtime.types.js';

// Marks a write route: after it succeeds, everyone with its project open is told (see
// BroadcastInterceptor). Every POST / PATCH / PUT / DELETE route carries @Broadcast or
// @NoBroadcast; a test fails otherwise, so a new route can't forget it.

/** Finds the project a request is about. Runs before the handler, so a delete still knows it. */
export type ProjectLocator = (request: Request, db: DataSource) => Promise<string | undefined>;

export interface BroadcastOptions {
  entity: RealtimeEntity;
  action: Exclude<RealtimeAction, 'resync'>;
  project: ProjectLocator;
}

export const BROADCAST = 'realtime:broadcast';
export const NO_BROADCAST = 'realtime:no-broadcast';

export const Broadcast = (options: BroadcastOptions) => SetMetadata(BROADCAST, options);

/** A write route that deliberately tells no one (the reason is for the reader). */
export const NoBroadcast = (reason: string) => SetMetadata(NO_BROADCAST, reason);

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** The project id is a field of the body (creating a task or an event). */
export const projectInBody =
  (field = 'projectId'): ProjectLocator =>
  (request) =>
    Promise.resolve(text((request.body as Record<string, unknown> | undefined)?.[field]));

/** The project id is a route parameter (the project routes themselves). */
export const projectInParam =
  (param = 'id'): ProjectLocator =>
  (request) =>
    Promise.resolve(text(request.params[param]));

/**
 * The project of a row: the row's id is in the route parameter `param` (or, with `from: 'body'`,
 * in that field of the body), and the row has a `projectId` column.
 */
export const projectOfRow =
  (
    entity: EntityTarget<ObjectLiteral>,
    key = 'id',
    from: 'param' | 'body' = 'param',
  ): ProjectLocator =>
  async (request, db) => {
    const id =
      from === 'param'
        ? text(request.params[key])
        : text((request.body as Record<string, unknown> | undefined)?.[key]);
    // Interceptors run before the route's ParseUUIDPipe: a malformed id never reaches the query.
    if (!id || !isUUID(id)) return undefined;
    const row = await db
      .getRepository(entity)
      .createQueryBuilder('row')
      .select('row.projectId', 'projectId')
      .where('row.id = :id', { id })
      .getRawOne<{ projectId: string }>();
    return row?.projectId;
  };
