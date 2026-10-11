import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Broadcast, NoBroadcast } from '../realtime/broadcast.decorator.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { UpdateProjectDto } from './dto/update-project.dto.js';
import {
  NoProjectCheck,
  ProjectAccess,
  projectInParam,
  ProjectAccessGuard,
} from './project-access.js';
import { ProjectsService } from './projects.service.js';

/**
 * Your projects: the ones you are a member of, each with your role in it. Only members see one
 * (404 for anyone else) and only its owners change it. Changes are told to everyone with the
 * project open (@Broadcast).
 */
@Controller('projects')
@UseGuards(AuthGuard, ProjectAccessGuard)
@ApiBearerAuth()
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  /** A new project; you are its first owner. No one has it open yet, so no one is told. */
  @Post()
  @NoProjectCheck('it becomes yours')
  @NoBroadcast('a new project has no one in its room')
  create(@Body() createProjectDto: CreateProjectDto, @CurrentUser() userId: string) {
    return this.projectsService.create(createProjectDto, userId);
  }

  /** The projects you are a member of, newest first. */
  @Get()
  @NoProjectCheck('lists only your own')
  findAll(@CurrentUser() userId: string) {
    return this.projectsService.findAll(userId);
  }

  @Get(':id')
  @ProjectAccess('viewer', projectInParam())
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() userId: string) {
    return this.projectsService.findOne(id, userId);
  }

  @Patch(':id')
  @ProjectAccess('owner', projectInParam())
  @Broadcast({ entity: 'project', action: 'update', project: projectInParam() })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateProjectDto: UpdateProjectDto,
    @CurrentUser() userId: string,
  ) {
    return this.projectsService.update(id, updateProjectDto, userId);
  }

  @Patch(':id/archive')
  @ProjectAccess('owner', projectInParam())
  @Broadcast({ entity: 'project', action: 'update', project: projectInParam() })
  archive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() userId: string) {
    return this.projectsService.archive(id, userId);
  }

  @Patch(':id/reopen')
  @ProjectAccess('owner', projectInParam())
  @Broadcast({ entity: 'project', action: 'update', project: projectInParam() })
  reopen(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() userId: string) {
    return this.projectsService.reopen(id, userId);
  }

  // Tells whoever has it open, so they can move off it.
  @Delete(':id')
  @ProjectAccess('owner', projectInParam())
  @Broadcast({ entity: 'project', action: 'delete', project: projectInParam() })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectsService.remove(id);
  }
}
