import { IfMatch } from '../revisions/if-match.decorator.js';
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
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard.js';
import {
  ProjectAccess,
  projectInQuery,
  projectOfRow,
  ProjectAccessGuard,
} from '../projects/project-access.js';
import { Broadcast } from '../realtime/broadcast.decorator.js';
import { DependenciesService } from './dependencies.service.js';
import { CreateDependencyDto } from './dto/create-dependency.dto.js';
import { UpdateDependencyDto } from './dto/update-dependency.dto.js';
import { TaskDependency } from './entities/task-dependency.entity.js';
import { projectOfTask } from '../tasks/task-project.js';
import { AnswerWithChanges } from '../realtime/dto/row-changes.dto.js';

// Each route says the role it needs in the project (@ProjectAccess: viewers read, editors change;
// 404 for non-members) and each write who is told after it (@Broadcast: everyone with it open).
@ApiTags('dependencies')
@Controller('dependencies')
@UseGuards(AuthGuard, ProjectAccessGuard)
@ApiBearerAuth()
export class DependenciesController {
  constructor(private readonly dependencyService: DependenciesService) {}

  /** Every link between the tasks of a project. */
  @Get()
  @ProjectAccess('viewer', projectInQuery())
  findByProject(@Query('projectId', ParseUUIDPipe) projectId: string) {
    return this.dependencyService.findByProject(projectId);
  }

  /** Make `toTaskId` come after `fromTaskId`. Rejects self links, duplicates and cycles; moves the successor later if it is too early. */
  // A new link's project is its first task's (the service checks both tasks share it).
  @Post()
  @ProjectAccess('editor', projectOfTask('fromTaskId', 'body'))
  @AnswerWithChanges('TaskDependency', 201)
  @Broadcast({
    entity: 'dependency',
    action: 'create',
    project: projectOfTask('fromTaskId', 'body'),
  })
  create(@Body() dto: CreateDependencyDto) {
    return this.dependencyService.create(dto);
  }

  /** Change the type and/or the lag of a link. */
  @Patch(':id')
  @IfMatch()
  @ProjectAccess('editor', projectOfRow(TaskDependency))
  @AnswerWithChanges('TaskDependency')
  @Broadcast({ entity: 'dependency', action: 'update', project: projectOfRow(TaskDependency) })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDependencyDto) {
    return this.dependencyService.update(id, dto);
  }

  @Delete(':id')
  @IfMatch()
  @HttpCode(204)
  @ProjectAccess('editor', projectOfRow(TaskDependency))
  @Broadcast({ entity: 'dependency', action: 'delete', project: projectOfRow(TaskDependency) })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.dependencyService.remove(id);
  }
}
