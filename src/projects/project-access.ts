import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import { DataSource, type EntityTarget, type ObjectLiteral } from 'typeorm';
import type { AuthedRequest } from '../auth/auth.guard.js';
import { Project } from './entities/project.entity.js';

// Every project has an owner, and only the owner sees or changes it (and its tasks, links and
// events). Each route says how to find its project (@OwnedProject), or that it has none to check
// (@NoProjectCheck: listing and creating your own projects). ProjectOwnerGuard, after AuthGuard,
// answers 404 for a project that is not yours, the same as for one that does not exist, so other
// people's projects can't even be found. A test fails for a route with neither mark.
// Members and roles (#18, #20) will let others in.

/**
 * Finds the project a request is about. Runs before the handler and its pipes. Answers the project
 * id; `undefined` when there is nothing to check (no id, or a malformed one: the route answers that
 * itself); `null` for a well-formed id of a row that doesn't exist.
 */
export type ProjectLocator = (
  request: Request,
  db: DataSource,
) => Promise<string | null | undefined>;

export const OWNED_PROJECT = 'projects:owned-project';
export const NO_PROJECT_CHECK = 'projects:no-project-check';

export const OwnedProject = (locator: ProjectLocator) => SetMetadata(OWNED_PROJECT, locator);
/** A route with no single project to check (the reason is for the reader). */
export const NoProjectCheck = (reason: string) => SetMetadata(NO_PROJECT_CHECK, reason);

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
const fromBody = (request: Request, field: string) =>
  text((request.body as Record<string, unknown> | undefined)?.[field]);

/** The project id is a field of the body (creating a task or an event). */
export const projectInBody =
  (field = 'projectId'): ProjectLocator =>
  (request) =>
    Promise.resolve(fromBody(request, field));

/** The project id is in the query (`GET /tasks?projectId=`). */
export const projectInQuery =
  (field = 'projectId'): ProjectLocator =>
  (request) =>
    Promise.resolve(text(request.query[field]));

/** The project id is a route parameter (the project routes themselves). */
export const projectInParam =
  (param = 'id'): ProjectLocator =>
  (request) =>
    Promise.resolve(text(request.params[param]));

/**
 * The project of a row: its id is in the route parameter `key` (or, with `from: 'body'`, in that
 * field of the body), and the row has a `projectId` column.
 */
export const projectOfRow =
  (
    entity: EntityTarget<ObjectLiteral>,
    key = 'id',
    from: 'param' | 'body' = 'param',
  ): ProjectLocator =>
  async (request, db) => {
    const id = from === 'param' ? text(request.params[key]) : fromBody(request, key);
    // Guards run before the route's ParseUUIDPipe: a malformed id never reaches the query.
    if (!id || !isUUID(id)) return undefined;
    const row = await db
      .getRepository(entity)
      .createQueryBuilder('row')
      .select('row.projectId', 'projectId')
      .where('row.id = :id', { id })
      .getRawOne<{ projectId: string }>();
    return row?.projectId ?? null;
  };

@Injectable()
export class ProjectOwnerGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const locator = this.reflector.get<ProjectLocator | undefined>(
      OWNED_PROJECT,
      context.getHandler(),
    );
    if (!locator) return true;
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const projectId = await locator(request, this.db);
    // Nothing to check (no id, or a malformed one): the route itself answers that (400), the same
    // for everyone.
    if (projectId === undefined || (projectId !== null && !isUUID(projectId))) return true;
    // A row that doesn't exist gets the same answer as one in someone else's project, so the two
    // can't be told apart.
    if (projectId === null) throw new NotFoundException('Not found');
    const owned = await this.db
      .getRepository(Project)
      .existsBy({ id: projectId, ownerId: request.userId });
    if (!owned) throw new NotFoundException('Not found');
    return true;
  }
}
