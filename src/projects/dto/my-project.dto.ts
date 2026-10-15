import { ApiProperty, OmitType } from '@nestjs/swagger';
import { MEMBER_ROLES, type MemberRole } from '../../members/member-role.js';
import { Project } from '../entities/project.entity.js';

/** Someone who added a member to a project. */
export class AddedByDto {
  id: string;
  name: string;
}

/**
 * A project as the signed-in user sees it: with their place in it. Their role says what they may
 * do (see members/member-role.ts); `joinedAt` and `addedBy` say when and by whom they were added.
 */
export class MyProjectDto extends OmitType(Project, ['tasks', 'members'] as const) {
  @ApiProperty({ enum: MEMBER_ROLES, enumName: 'MemberRole' })
  role: MemberRole;

  joinedAt: Date;

  /** null when they made the project (or that account is deleted). */
  addedBy: AddedByDto | null;
}

/** A membership as far as this DTO reads it (loaded with `project` and `addedBy`). */
interface Membership {
  project: Project;
  role: MemberRole;
  joinedAt: Date;
  addedBy: AddedByDto | null;
}

/** The project of a membership, with that member's place. */
export const asMyProject = (member: Membership): MyProjectDto => {
  const { project, addedBy } = member;
  return {
    // Only the project's own columns (not a relation that happens to be loaded).
    id: project.id,
    name: project.name,
    description: project.description,
    archived: project.archived,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    version: project.version,
    role: member.role,
    joinedAt: member.joinedAt,
    addedBy: addedBy ? { id: addedBy.id, name: addedBy.name } : null,
  };
};
