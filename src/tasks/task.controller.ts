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
import { ChangeTypeDto } from './dto/change-type.dto.js';
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
  create(@Body() dto: TaskDto) {
    return this.taskService.create(dto);
  }

  /** Change any of name, description, dates, progress, priority and color. */
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTaskDto) {
    return this.taskService.update(id, dto);
  }

  /** Sub-tasks of a deleted group are kept and become top-level. */
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.taskService.remove(id);
  }

  /** Move a task under a group, or send { "parentId": null } to make it top-level. */
  @Patch(':id/parent')
  setParent(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetParentDto) {
    return this.taskService.setParent(id, dto.parentId);
  }

  @Patch(':id/type')
  changeType(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeTypeDto) {
    return this.taskService.changeType(id, dto.type);
  }
}
