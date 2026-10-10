import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import { DataSource, type EntityTarget, type ObjectLiteral } from 'typeorm';
import type { AuthedRequest } from '../auth/auth.guard.js';
import { Member } from '../members/entities/member.entity.js';
import { type MemberRole, roleCovers } from '../members/member-role.js';

// Only a project's members see it (and its tasks, links, events and members), and their role says
// what they may change (see members/member-role.ts). Each route says how to find its project and
// the role it needs (@ProjectAccess), or that it has none to check (@NoProjectCheck: listing and
// creating your own projects). ProjectAccessGuard, after AuthGuard, answers 404 to someone who is
// not a member, the same as for a project that does not exist, so other people's projects can't
// even be found; a member whose role is too low gets 403. A test fails for a route with neither mark.

/**
 * Finds the project a request is about. Runs before the handler and its pipes. Answers the project
 * id; `undefined` when there is nothing to check (no id, or a malformed one: the route answers that
 * itself); `null` for a well-formed id of a row that doesn't exist.
 */
export type ProjectLocator = (
  request: Request,
  db: DataSource,
) => Promise<string | null | undefined>;

export interface ProjectAccessOptions {
  role: MemberRole;
  project: ProjectLocator;
}

export const PROJECT_ACCESS = 'projects:project-access';
export const NO_PROJECT_CHECK = 'projects:no-project-check';

/** The route works on the project `project` finds, and needs at least `role` in it. */
export const ProjectAccess = (role: MemberRole, project: ProjectLocator) =>
  SetMetadata(PROJECT_ACCESS, { role, project } satisfies ProjectAccessOptions);
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

/** What a member whose role is too low is told. */
const refusal = (needed: MemberRole) =>
  needed === 'owner'
    ? 'Only an owner of this project can do this'
    : 'You can only view this project';

@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = this.reflector.get<ProjectAccessOptions | undefined>(
      PROJECT_ACCESS,
      context.getHandler(),
    );
    if (!access) return true;
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const projectId = await access.project(request, this.db);
    // Nothing to check (no id, or a malformed one): the route itself answers that (400), the same
    // for everyone.
    if (projectId === undefined || (projectId !== null && !isUUID(projectId))) return true;
    // A row that doesn't exist gets the same answer as one in a project you are not in, so the two
    // can't be told apart.
    if (projectId === null) throw new NotFoundException('Not found');
    const role = await roleIn(this.db, projectId, request.userId);
    if (!role) throw new NotFoundException('Not found');
    if (!roleCovers(role, access.role)) throw new ForbiddenException(refusal(access.role));
    return true;
  }
}

/** Someone's role in a project, or null when they are not a member. */
export const roleIn = async (
  db: DataSource,
  projectId: string,
  userId: string,
): Promise<MemberRole | null> => {
  const member = await db
    .getRepository(Member)
    .findOne({ select: { role: true }, where: { projectId, userId } });
  return member?.role ?? null;
};
