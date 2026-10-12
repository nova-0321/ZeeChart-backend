import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import type { Invitation } from '../entities/invitation.entity.js';
import { MEMBER_ROLES, type MemberRole } from '../member-role.js';
import { MemberDto } from './member.dto.js';

/** A pending invitation: someone with no account yet, who joins with its link (see InvitePreviewDto). */
export class InvitationDto {
  id: string;
  projectId: string;
  email: string;

  @ApiProperty({ enum: MEMBER_ROLES, enumName: 'MemberRole' })
  role: MemberRole;

  /** Who invited them, and their name (null once that account is deleted). */
  invitedById: string | null;
  invitedByName: string | null;
  createdAt: Date;
  /** Its link works until then. */
  expiresAt: Date;
}

/** What an invite did: added someone who has an account, or made an invitation with a link. */
export class InviteResultDto {
  @ApiProperty({ enum: ['added', 'invited'] })
  status: 'added' | 'invited';

  /** The new member (when `added`). */
  @ApiProperty({ type: MemberDto, nullable: true })
  member: MemberDto | null;

  /** The new invitation (when `invited`). */
  @ApiProperty({ type: InvitationDto, nullable: true })
  invitation: InvitationDto | null;

  /**
   * The secret of its link (when `invited`): shown this once, never stored. The app's link is
   * /invite/<token>.
   */
  @ApiProperty({ type: String, nullable: true })
  token: string | null;
}

/** A new link for a pending invitation (the old one stops working). */
export class InviteLinkDto {
  token: string;
  invitation: InvitationDto;
}

/** What an invite link is for, shown to whoever opens it (before they sign in). */
export class InvitePreviewDto {
  projectName: string;
  /** Who invited them (null once that account is deleted). */
  invitedByName: string | null;

  @ApiProperty({ enum: MEMBER_ROLES, enumName: 'MemberRole' })
  role: MemberRole;
  expiresAt: Date;
}

/** An invite link's secret (to look at what it is for, or to take it up). */
export class AcceptInviteDto {
  @IsString()
  @Length(20, 100)
  token: string;
}

/** The project an accepted invite link joined. */
export class AcceptedInviteDto {
  projectId: string;
  /** They were in it already: nothing changed, and the link was left for the person it is for. */
  alreadyMember: boolean;
}

/** An invitation row with `invitedBy` loaded, as the API answers it. */
export const asInvitationDto = (invitation: Invitation): InvitationDto => ({
  id: invitation.id,
  projectId: invitation.projectId,
  email: invitation.email,
  role: invitation.role,
  invitedById: invitation.invitedById,
  invitedByName: invitation.invitedBy?.name ?? null,
  createdAt: invitation.createdAt,
  expiresAt: invitation.expiresAt,
});
