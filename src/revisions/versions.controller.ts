import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
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
import type { MyProjectDto } from '../projects/dto/my-project.dto.js';
import { Broadcast, NoBroadcast } from '../realtime/broadcast.decorator.js';
import {
  type RestoreVersionResultDto,
  StarVersionDto,
  type VersionDto,
  type VersionSummaryDto,
} from './dto/version.dto.js';
import { ProjectVersion } from './entities/project-version.entity.js';
import type { RevisionRequest } from './revision.interceptor.js';
import { VersionsService } from './versions.service.js';

// Versions of a whole project: every member sees them, editors save, star and restore them.

@Controller('projects/:id/versions')
@UseGuards(AuthGuard, ProjectAccessGuard)
@ApiBearerAuth()
export class ProjectVersionsController {
  constructor(private readonly versions: VersionsService) {}

  /** The project's versions, newest first (without their contents). */
  @Get()
  @ProjectAccess('viewer', projectInParam())
  list(@Param('id', ParseUUIDPipe) projectId: string): Promise<VersionSummaryDto[]> {
    return this.versions.list(projectId);
  }

  /** "Save a version now": the project as it is. */
  @Post()
  // Saving a version records the plan as it is: allowed on an archived project.
  @ProjectAccess('editor', projectInParam(), { whileArchived: true })
  @Broadcast({ entity: 'version', action: 'create', project: projectInParam() })
  save(
    @Param('id', ParseUUIDPipe) projectId: string,
    @CurrentUser() userId: string,
  ): Promise<VersionDto> {
    return this.versions.saveNow(projectId, userId);
  }
}

@Controller('versions')
@UseGuards(AuthGuard, ProjectAccessGuard)
@ApiBearerAuth()
export class VersionsController {
  constructor(private readonly versions: VersionsService) {}

  /** One version with its contents (to look at it). */
  @Get(':id')
  @ProjectAccess('viewer', projectOfRow(ProjectVersion))
  get(@Param('id', ParseUUIDPipe) id: string): Promise<VersionDto> {
    return this.versions.get(id);
  }

  /** Star a version (or take the star off). */
  @Patch(':id')
  @ProjectAccess('editor', projectOfRow(ProjectVersion), { whileArchived: true })
  @Broadcast({ entity: 'version', action: 'update', project: projectOfRow(ProjectVersion) })
  star(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StarVersionDto): Promise<VersionDto> {
    return this.versions.star(id, dto.starred);
  }

  /**
   * A new project of yours made from this version (named "<name> (v3)"); this one is not touched.
   * Any member may: they can see the version already, and the copy is theirs.
   */
  @Post(':id/copy')
  @ProjectAccess('viewer', projectOfRow(ProjectVersion))
  @NoBroadcast('a new project has no one in its room')
  copy(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() userId: string,
  ): Promise<MyProjectDto> {
    return this.versions.copy(id, userId);
  }

  /**
   * Put the whole project back as it was in this version (tasks, events, links; the name and
   * description too for an owner). The state it replaces is kept as a version first; newer
   * versions go, except starred and manually saved ones.
   */
  @Post(':id/restore')
  @ProjectAccess('editor', projectOfRow(ProjectVersion))
  @Broadcast({ entity: 'version', action: 'update', project: projectOfRow(ProjectVersion) })
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() userId: string,
    @Req() request: RevisionRequest,
  ): Promise<RestoreVersionResultDto> {
    const result = await this.versions.restore(id, userId);
    // Every change it made is in the per-item history with this note (RevisionInterceptor).
    request.revisionWholeProject = true;
    request.revisionNote = `Restored version v${result.version}`;
    return result;
  }
}
