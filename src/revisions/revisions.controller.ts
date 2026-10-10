import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
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
import type { RestoreResultDto } from './dto/restore-result.dto.js';
import { RevisionsQueryDto } from './dto/revisions-query.dto.js';
import { Revision } from './entities/revision.entity.js';
import type { RevisionRequest } from './revision.interceptor.js';
import { RevisionsService } from './revisions.service.js';

// Every member reads the history; editors restore tasks and events from it, owners also the
// project itself.

@Controller('projects/:id/revisions')
@UseGuards(AuthGuard, ProjectAccessGuard)
@ApiBearerAuth()
export class ProjectRevisionsController {
  constructor(private readonly revisions: RevisionsService) {}

  /**
   * The project's history, newest first, 50 at a time (up to 100 with `limit`). For the next page,
   * pass the id of the last one as `before`.
   */
  @Get()
  @ProjectAccess('viewer', projectInParam())
  list(@Param('id', ParseUUIDPipe) projectId: string, @Query() query: RevisionsQueryDto) {
    return this.revisions.list(projectId, query.before, query.limit);
  }
}

@Controller('revisions')
@UseGuards(AuthGuard, ProjectAccessGuard)
@ApiBearerAuth()
export class RevisionsController {
  constructor(private readonly revisions: RevisionsService) {}

  /**
   * Put a task, an event or the project back the way it was right after this revision (a deleted
   * one comes back, with its links where the other task is still there). It is recorded as a new
   * change ("Restored to version N"). 400 when it can't be put back as things are now.
   */
  @Post(':id/restore')
  @ProjectAccess('editor', projectOfRow(Revision))
  @Broadcast({ entity: 'revision', action: 'update', project: projectOfRow(Revision) })
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() userId: string,
    @Req() request: RevisionRequest,
  ): Promise<RestoreResultDto> {
    const result = await this.revisions.restore(id, userId);
    // For the history of this restore (RevisionInterceptor).
    request.revisionTarget = result.entityId;
    request.revisionNote = `Restored to version ${result.version}`;
    return result;
  }
}
