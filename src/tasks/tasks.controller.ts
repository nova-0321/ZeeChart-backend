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
  projectInBody,
  projectInQuery,
  projectOfRow,
  ProjectAccessGuard,
} from '../projects/project-access.js';
import { Broadcast } from '../realtime/broadcast.decorator.js';
import { ChangeTaskTypeDto } from './dto/change-task-type.dto.js';
import { MoveTaskDto } from './dto/move-task.dto.js';
import { CreateTaskDto } from './dto/create-task.dto.js';
import { UpdateTaskDto } from './dto/update-task.dto.js';
import { Task } from './entities/task.entity.js';
import { TasksService } from './tasks.service.js';
import { AnswerWithChanges } from '../realtime/dto/row-changes.dto.js';

// Each route says the role it needs in the project (@ProjectAccess: viewers read, editors change;
// 404 for non-members) and each write who is told after it (@Broadcast: everyone with it open).
@ApiTags('tasks')
@Controller('tasks')
@UseGuards(AuthGuard, ProjectAccessGuard)
@ApiBearerAuth()
export class TasksController {
  constructor(private readonly taskService: TasksService) {}

  /** Flat list for a project; the client builds the tree from parentId. */
  @Get()
  @ProjectAccess('viewer', projectInQuery())
  findByProject(@Query('projectId', ParseUUIDPipe) projectId: string) {
    return this.taskService.findByProject(projectId);
  }

  @Post()
  @ProjectAccess('editor', projectInBody())
  @AnswerWithChanges('Task', 201)
  @Broadcast({ entity: 'task', action: 'create', project: projectInBody() })
  create(@Body() dto: CreateTaskDto) {
    return this.taskService.create(dto);
  }

  /** Change any of name, description, dates, progress, priority and color. */
  @Patch(':id')
  @IfMatch()
  @ProjectAccess('editor', projectOfRow(Task))
  @AnswerWithChanges('Task')
  @Broadcast({ entity: 'task', action: 'update', project: projectOfRow(Task) })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTaskDto) {
    return this.taskService.update(id, dto);
  }

  /** Sub-tasks of a deleted group are kept and become top-level. */
  @Delete(':id')
  @IfMatch()
  @HttpCode(204)
  @ProjectAccess('editor', projectOfRow(Task))
  @Broadcast({ entity: 'task', action: 'delete', project: projectOfRow(Task) })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.taskService.remove(id);
  }

  /**
   * Put a task at a place in the list: under a group (or at the top level, with null) and at an
   * index among the tasks there (past the end: last). The tasks of that level are numbered again to
   * keep that order. The one way to change a task's group: dropped on a plain task, that task
   * becomes a group holding it; a milestone holds nothing.
   */
  @Patch(':id/move')
  @IfMatch()
  @ProjectAccess('editor', projectOfRow(Task))
  @AnswerWithChanges('Task')
  @Broadcast({ entity: 'task', action: 'update', project: projectOfRow(Task) })
  move(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveTaskDto) {
    return this.taskService.move(id, dto.parentId, dto.index);
  }

  @Patch(':id/type')
  @IfMatch()
  @ProjectAccess('editor', projectOfRow(Task))
  @AnswerWithChanges('Task')
  @Broadcast({ entity: 'task', action: 'update', project: projectOfRow(Task) })
  changeType(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeTaskTypeDto) {
    return this.taskService.changeType(id, dto.type);
  }
}
