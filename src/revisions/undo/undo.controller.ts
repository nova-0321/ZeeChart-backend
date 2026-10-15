import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../auth/auth.guard.js';
import { CurrentUser } from '../../auth/current-user.decorator.js';
import {
  ProjectAccess,
  ProjectAccessGuard,
  projectInParam,
} from '../../projects/project-access.js';
import { Broadcast } from '../../realtime/broadcast.decorator.js';
import { UndoStateDto, UndoStepDto } from './dto/undo.dto.js';
import type { RevisionRequest } from '../revision.interceptor.js';
import { UndoService } from './undo.service.js';

// Undo and redo of your own changes in a project (see UndoService). Viewers make no changes, so
// they have nothing to undo; editors and owners do.

@ApiTags('undo')
@Controller('projects/:id')
@UseGuards(AuthGuard, ProjectAccessGuard)
@ApiBearerAuth()
export class UndoController {
  constructor(private readonly undos: UndoService) {}

  /** What Undo and Redo would do now (null: nothing), for the buttons. */
  @Get('undo-state')
  @ProjectAccess('viewer', projectInParam())
  state(
    @Param('id', ParseUUIDPipe) projectId: string,
    @CurrentUser() userId: string,
  ): Promise<UndoStateDto> {
    return this.undos.state(projectId, userId);
  }

  /**
   * The same as GET undo-state, under its old name (#57: it read like the action, POST undo). Kept
   * until the frontend asks for undo-state; then removed.
   */
  @Get('undo')
  @ApiOperation({ deprecated: true })
  @ProjectAccess('viewer', projectInParam())
  oldState(
    @Param('id', ParseUUIDPipe) projectId: string,
    @CurrentUser() userId: string,
  ): Promise<UndoStateDto> {
    return this.undos.state(projectId, userId);
  }

  /**
   * Undo your last change here (from any tab or device). 409 when there is none, or when someone
   * changed what it changed since (nothing is overwritten).
   */
  @Post('undo')
  // A change made, not a thing created: 200, not 201 (#57).
  @HttpCode(200)
  @ProjectAccess('editor', projectInParam())
  @Broadcast({ entity: 'revision', action: 'update', project: projectInParam() })
  async undo(
    @Param('id', ParseUUIDPipe) projectId: string,
    @CurrentUser() userId: string,
    @Req() request: RevisionRequest,
  ): Promise<UndoStepDto> {
    const { step, placed } = await this.undos.undo(projectId, userId);
    request.revisionBatch = { kind: 'undo', of: step.batchId };
    request.revisionPlaced = new Set(placed);
    request.revisionWholeProject = true;
    request.revisionNote = 'Undo';
    return step;
  }

  /** Redo what your last undo reverted. 409 when there is none, or it no longer fits. */
  @Post('redo')
  @HttpCode(200)
  @ProjectAccess('editor', projectInParam())
  @Broadcast({ entity: 'revision', action: 'update', project: projectInParam() })
  async redo(
    @Param('id', ParseUUIDPipe) projectId: string,
    @CurrentUser() userId: string,
    @Req() request: RevisionRequest,
  ): Promise<UndoStepDto> {
    const { step, placed } = await this.undos.redo(projectId, userId);
    request.revisionBatch = { kind: 'redo', of: step.batchId };
    request.revisionPlaced = new Set(placed);
    request.revisionWholeProject = true;
    request.revisionNote = 'Redo';
    return step;
  }
}
