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
import { ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard.js';
import {
  OwnedProject,
  projectInQuery,
  projectOfRow,
  ProjectOwnerGuard,
} from '../projects/project-access.js';
import { Broadcast } from '../realtime/broadcast.decorator.js';
import { DependencyService } from './dependency.service.js';
import { DependencyDto } from './dto/dependency.dto.js';
import { UpdateDependencyDto } from './dto/update-dependency.dto.js';
import { TaskDependency } from './entities/task-dependency.entity.js';
import { Task } from '../tasks/entities/task.entity.js';

// Each write route says who may make the change (@OwnedProject: the project's owner, 404 for
// anyone else) and who is told after it (@Broadcast: everyone with the project open).
@Controller('dependencies')
@UseGuards(AuthGuard, ProjectOwnerGuard)
@ApiBearerAuth()
export class DependencyController {
  constructor(private readonly dependencyService: DependencyService) {}

  /** Every link between the tasks of a project. */
  @Get()
  @OwnedProject(projectInQuery())
  findByProject(@Query('projectId', ParseUUIDPipe) projectId: string) {
    return this.dependencyService.findByProject(projectId);
  }

  /** Make `toTaskId` come after `fromTaskId`. Rejects self links, duplicates and cycles; moves the successor later if it is too early. */
  // A new link's project is its first task's (the service checks both tasks share it).
  @Post()
  @OwnedProject(projectOfRow(Task, 'fromTaskId', 'body'))
  @Broadcast({
    entity: 'dependency',
    action: 'create',
    project: projectOfRow(Task, 'fromTaskId', 'body'),
  })
  create(@Body() dto: DependencyDto) {
    return this.dependencyService.create(dto);
  }

  /** Change the type and/or the lag of a link. */
  @Patch(':id')
  @OwnedProject(projectOfRow(TaskDependency))
  @Broadcast({ entity: 'dependency', action: 'update', project: projectOfRow(TaskDependency) })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDependencyDto) {
    return this.dependencyService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @OwnedProject(projectOfRow(TaskDependency))
  @Broadcast({ entity: 'dependency', action: 'delete', project: projectOfRow(TaskDependency) })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.dependencyService.remove(id);
  }
}
