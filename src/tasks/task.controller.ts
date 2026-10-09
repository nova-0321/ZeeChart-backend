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
} from '@nestjs/common';
import { Broadcast, projectInBody, projectOfRow } from '../realtime/broadcast.decorator.js';
import { ChangeTypeDto } from './dto/change-type.dto.js';
import { Task } from './entities/task.entity.js';
import { MoveTaskDto } from './dto/move-task.dto.js';
import { SetParentDto } from './dto/set-parent.dto.js';
import { TaskDto } from './dto/task.dto.js';
import { UpdateTaskDto } from './dto/update-task.dto.js';
import { TaskService } from './task.service.js';

@Controller('tasks')
export class TaskController {
  constructor(private readonly taskService: TaskService) {}

  /** Flat list for a project; the client builds the tree from parentId. */
  @Get()
  findByProject(@Query('projectId', ParseUUIDPipe) projectId: string) {
    return this.taskService.findByProject(projectId);
  }

  @Post()
  @Broadcast({ entity: 'task', action: 'create', project: projectInBody() })
  create(@Body() dto: TaskDto) {
    return this.taskService.create(dto);
  }

  /** Change any of name, description, dates, progress, priority and color. */
  @Patch(':id')
  @Broadcast({ entity: 'task', action: 'update', project: projectOfRow(Task) })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTaskDto) {
    return this.taskService.update(id, dto);
  }

  /** Sub-tasks of a deleted group are kept and become top-level. */
  @Delete(':id')
  @HttpCode(204)
  @Broadcast({ entity: 'task', action: 'delete', project: projectOfRow(Task) })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.taskService.remove(id);
  }

  /** Move a task under a group, or send { "parentId": null } to make it top-level. */
  @Patch(':id/parent')
  @Broadcast({ entity: 'task', action: 'update', project: projectOfRow(Task) })
  setParent(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetParentDto) {
    return this.taskService.setParent(id, dto.parentId);
  }

  /**
   * Put a task at a place in the list: under a group (or at the top level, with null) and at an
   * index among the tasks there. The tasks of that level are numbered again to keep that order.
   */
  @Patch(':id/move')
  @Broadcast({ entity: 'task', action: 'update', project: projectOfRow(Task) })
  move(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveTaskDto) {
    return this.taskService.move(id, dto.parentId, dto.index);
  }

  @Patch(':id/type')
  @Broadcast({ entity: 'task', action: 'update', project: projectOfRow(Task) })
  changeType(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeTypeDto) {
    return this.taskService.changeType(id, dto.type);
  }
}
