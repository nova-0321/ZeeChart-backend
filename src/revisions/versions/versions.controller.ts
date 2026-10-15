import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../../auth/auth.guard.js';
import { CurrentUser } from '../../auth/current-user.decorator.js';
import {
  ProjectAccess,
  ProjectAccessGuard,
  projectInParam,
  projectOfRow,
} from '../../projects/project-access.js';
import type { MyProjectDto } from '../../projects/dto/my-project.dto.js';
import { Broadcast, NoBroadcast } from '../../realtime/broadcast.decorator.js';
import {
  type RestoreVersionResultDto,
  StarVersionDto,
  VersionDto,
  type VersionSummaryDto,
} from './dto/version.dto.js';
import { PageQueryDto } from '../history/dto/page-query.dto.js';
import { ProjectVersion } from '../entities/project-version.entity.js';
import { SAVE_VERSION_LIMIT } from '../history-limits.js';
import type { RevisionRequest } from '../revision.interceptor.js';
import { VersionsService } from './versions.service.js';

// Versions of a whole project: every member sees them, editors save, star and restore them.

@ApiTags('versions')
@Controller('projects/:id/versions')
@UseGuards(AuthGuard, ProjectAccessGuard)
@ApiBearerAuth()
export class ProjectVersionsController {
  constructor(private readonly versions: VersionsService) {}

  /**
   * The project's versions, newest first (without their contents), 50 at a time (up to 100 with
   * `limit`). For the next page, pass the id of the last one as `before`.
   */
  @Get()
  @ProjectAccess('viewer', projectInParam())
  list(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Query() query: PageQueryDto,
  ): Promise<VersionSummaryDto[]> {
    return this.versions.list(projectId, query.before, query.limit);
  }

  /** "Save a version now": the project as it is. */
  @Post()
  @ApiCreatedResponse({ type: VersionDto, description: 'A new version' })
  @ApiOkResponse({
    type: VersionDto,
    description: 'Nothing changed since the newest version: that one, kept as saved by hand',
  })
  // Each one stores the whole project: a few a minute is plenty.
  @Throttle({ default: { limit: SAVE_VERSION_LIMIT, ttl: 60_000 } })
  // Saving a version records the plan as it is: allowed on an archived project.
  @ProjectAccess('editor', projectInParam(), { whileArchived: true })
  @Broadcast({ entity: 'version', action: 'create', project: projectInParam() })
  async save(
    @Param('id', ParseUUIDPipe) projectId: string,
    @CurrentUser() userId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VersionDto> {
    const { version, created } = await this.versions.saveNow(projectId, userId);
    if (!created) response.status(HttpStatus.OK);
    return version;
  }
}

@ApiTags('versions')
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
  // The plan put back, not a thing created: 200, not 201 (#57).
  @HttpCode(200)
  @ProjectAccess('editor', projectOfRow(ProjectVersion))
  // The whole plan put back: the others load it again, rather than be sent every row (#75).
  @Broadcast({
    entity: 'version',
    action: 'update',
    project: projectOfRow(ProjectVersion),
    rows: false,
  })
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
