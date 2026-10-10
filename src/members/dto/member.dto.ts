import { ApiProperty } from '@nestjs/swagger';
import type { Member } from '../entities/member.entity.js';
import { MEMBER_ROLES, type MemberRole } from '../member-role.js';

/** A member of a project, with who they are. */
export class MemberDto {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  email: string;

  @ApiProperty({ enum: MEMBER_ROLES, enumName: 'MemberRole' })
  role: MemberRole;

  /** Who added them (null for the project's creator, or once that account is deleted). */
  addedById: string | null;
  joinedAt: Date;
}

/** A member row with its user loaded, as the API answers it. */
export const asMemberDto = (member: Member): MemberDto => ({
  id: member.id,
  projectId: member.projectId,
  userId: member.userId,
  name: member.user.name,
  email: member.user.email,
  role: member.role,
  addedById: member.addedById,
  joinedAt: member.joinedAt,
});
