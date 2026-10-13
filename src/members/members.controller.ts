import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import {
  NoProjectCheck,
  ProjectAccess,
  ProjectAccessGuard,
  projectInParam,
  projectOfRow,
} from '../projects/project-access.js';
import { Broadcast, NoBroadcast } from '../realtime/broadcast.decorator.js';
import { AddMemberDto } from './dto/add-member.dto.js';
import { ChangeRoleDto } from './dto/change-role.dto.js';
import {
  AcceptInviteDto,
  AcceptedInviteDto,
  InviteLinkDto,
  InvitePreviewDto,
  InviteResultDto,
} from './dto/invitation.dto.js';
import { Invitation } from './entities/invitation.entity.js';
import { Member } from './entities/member.entity.js';
import { MembersService } from './members.service.js';

// Every member sees who else is in the project; only its owners add, change or remove members.
// Each change is told to everyone with the project open (@Broadcast).

@Controller('projects/:id/members')
@UseGuards(AuthGuard, ProjectAccessGuard)
@ApiBearerAuth()
export class ProjectMembersController {
  constructor(private readonly members: MembersService) {}

  /** The project's members and their roles, in the order they joined. */
  @Get()
  @ProjectAccess('viewer', projectInParam())
  list(@Param('id', ParseUUIDPipe) projectId: string) {
    return this.members.list(projectId);
  }

  // No "add by email" here: people join only through an invitation (POST
  // /projects/:id/invitations), one path with one rate limit. A separate add route answered
  // "no one has signed up with this email" with no tighter limit, so emails could be looked up.
}

@Controller('members')
@UseGuards(AuthGuard, ProjectAccessGuard)
@ApiBearerAuth()
export class MembersController {
  constructor(private readonly members: MembersService) {}

  /** Change a member's role. 409 for the project's last owner. */
  @Patch(':id')
  @ProjectAccess('owner', projectOfRow(Member))
  @Broadcast({ entity: 'member', action: 'update', project: projectOfRow(Member) })
  changeRole(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeRoleDto) {
    return this.members.changeRole(id, dto.role);
  }

  /**
   * Remove a member from the project: an owner may remove anyone, and anyone may leave (remove
   * themselves). 409 for the project's last owner.
   */
  @Delete(':id')
  @HttpCode(204)
  @ProjectAccess('viewer', projectOfRow(Member))
  @Broadcast({ entity: 'member', action: 'delete', project: projectOfRow(Member) })
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() userId: string) {
    return this.members.remove(id, userId);
  }
}

// Invitations (#20): a place kept for someone with no account yet, taken up with a secret link (see
// InviteLinksController). Any member sees them; owners invite, cancel and make new links.

@Controller('projects/:id/invitations')
@UseGuards(AuthGuard, ProjectAccessGuard)
@ApiBearerAuth()
export class ProjectInvitationsController {
  constructor(private readonly members: MembersService) {}

  /** The project's pending invitations, oldest first. */
  @Get()
  @ProjectAccess('viewer', projectInParam())
  list(@Param('id', ParseUUIDPipe) projectId: string) {
    return this.members.listInvitations(projectId);
  }

  /**
   * Invite someone by email: added as a member at once when they have an account (`added`),
   * otherwise kept as an invitation until they sign up with it (`invited`). 409 when they are
   * already a member, or already invited.
   */
  @Post()
  @ProjectAccess('owner', projectInParam())
  @Broadcast({ entity: 'invitation', action: 'create', project: projectInParam() })
  // Inviting tells whether an email has an account (it adds them): not in bulk.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  invite(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() dto: AddMemberDto,
    @CurrentUser() userId: string,
  ): Promise<InviteResultDto> {
    return this.members.invite(projectId, dto, userId);
  }
}

@Controller('invitations')
@UseGuards(AuthGuard, ProjectAccessGuard)
@ApiBearerAuth()
export class InvitationsController {
  constructor(private readonly members: MembersService) {}

  /** Cancel a pending invitation (owners). */
  @Delete(':id')
  @HttpCode(204)
  @ProjectAccess('owner', projectOfRow(Invitation))
  @Broadcast({ entity: 'invitation', action: 'delete', project: projectOfRow(Invitation) })
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.members.cancelInvitation(id);
  }

  /**
   * A new secret link for a pending invitation, for another INVITE_DAYS days (owners). The old link
   * stops working. Only the new link's secret is answered, this once.
   */
  @Post(':id/link')
  @ProjectAccess('owner', projectOfRow(Invitation))
  @Broadcast({ entity: 'invitation', action: 'update', project: projectOfRow(Invitation) })
  renewLink(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() userId: string,
  ): Promise<InviteLinkDto> {
    return this.members.renewLink(id, userId);
  }
}

// Invite links (#20): opened by someone who is not in the project yet, maybe not even signed in.
// The link's secret is what lets them in; nothing about a project can be found without one.

@Controller('invites')
@UseGuards(ProjectAccessGuard)
export class InviteLinksController {
  constructor(private readonly members: MembersService) {}

  /**
   * What a link is for (the project's name, who invited, the role): 404 when unknown or expired.
   * A POST with the secret in the body, so it stays out of URLs (logs, history).
   */
  @Post('preview')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @NoProjectCheck('the link itself is the check')
  @NoBroadcast('changes nothing')
  preview(@Body() dto: AcceptInviteDto): Promise<InvitePreviewDto> {
    return this.members.preview(dto.token);
  }

  /** Join with a link, signed in: a member with its role; the link is used up. */
  @Post('accept')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(200)
  @NoProjectCheck('the link itself is the check')
  @NoBroadcast('the service tells the project itself (it is found from the link)')
  accept(@Body() dto: AcceptInviteDto, @CurrentUser() userId: string): Promise<AcceptedInviteDto> {
    return this.members.accept(dto.token, userId);
  }
}
