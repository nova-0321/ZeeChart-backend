import { NotFoundException } from '@nestjs/common';
import type { EntityTarget, ObjectLiteral } from 'typeorm';

// One shape for every 404 (#58): "<Thing> not found", named as the API's readers know it, never
// with the id (the caller sent it, and echoing it adds nothing). A row in a project you are not in
// gets the same answer as one that doesn't exist (see projects/project-access.ts), so the text
// must not tell the two apart either. A 404 with a reason of its own ("No one has signed up with
// this email", an invite link that expired) keeps that reason.

/** What a 404 can be about. */
export type Thing =
  | 'Project'
  | 'Task'
  | 'Link'
  | 'Event'
  | 'Member'
  | 'Invitation'
  | 'Version'
  | 'Revision'
  | 'Change'
  | 'Account'
  /** A row of a table not named below (a test fails first: see not-found.spec.ts). */
  | 'Item';

/** The 404 for a missing `thing`. */
export const notFound = (thing: Thing) => new NotFoundException(`${thing} not found`);

/** Each table's rows, by entity class name, as a 404 names them. */
const THING_OF_ENTITY: Record<string, Thing> = {
  Project: 'Project',
  Task: 'Task',
  TaskDependency: 'Link',
  ProjectEvent: 'Event',
  Member: 'Member',
  Invitation: 'Invitation',
  ProjectVersion: 'Version',
  Revision: 'Revision',
  User: 'Account',
};

/** The thing an entity's rows are (`findOneByOrFail` on it failed, or a route looked one up). */
export function thingOf(entity: EntityTarget<ObjectLiteral>): Thing {
  const name =
    typeof entity === 'function'
      ? entity.name
      : typeof entity === 'string'
        ? entity
        : 'name' in entity
          ? String(entity.name)
          : undefined;
  return (name !== undefined && THING_OF_ENTITY[name]) || 'Item';
}

/** Every entity name thingOf knows (a test checks each entity of the app is one of them). */
export const KNOWN_ENTITIES = Object.keys(THING_OF_ENTITY);
