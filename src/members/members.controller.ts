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
import { ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import {
  ProjectAccess,
  ProjectAccessGuard,
  projectInParam,
  projectOfRow,
} from '../projects/project-access.js';
import { Broadcast } from '../realtime/broadcast.decorator.js';
import { AddMemberDto } from './dto/add-member.dto.js';
import { ChangeRoleDto } from './dto/change-role.dto.js';
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

  /**
   * Add someone who has an account, by the email they signed up with (404 when no one has, 409
   * when they are already a member). An editor unless `role` says otherwise.
   */
  @Post()
  @ProjectAccess('owner', projectInParam())
  @Broadcast({ entity: 'member', action: 'create', project: projectInParam() })
  add(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() dto: AddMemberDto,
    @CurrentUser() userId: string,
  ) {
    return this.members.add(projectId, dto, userId);
  }
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
