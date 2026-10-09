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
import { Broadcast, projectOfRow } from '../realtime/broadcast.decorator.js';
import { DependencyService } from './dependency.service.js';
import { TaskDependency } from './entities/task-dependency.entity.js';
import { Task } from './entities/task.entity.js';
import { DependencyDto } from './dto/dependency.dto.js';
import { UpdateDependencyDto } from './dto/update-dependency.dto.js';

@Controller('dependencies')
export class DependencyController {
  constructor(private readonly dependencyService: DependencyService) {}

  /** Every link between the tasks of a project. */
  @Get()
  findByProject(@Query('projectId', ParseUUIDPipe) projectId: string) {
    return this.dependencyService.findByProject(projectId);
  }

  /** Make `toTaskId` come after `fromTaskId`. Rejects self links, duplicates and cycles; moves the successor later if it is too early. */
  // A new link's project is its first task's.
  @Post()
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
  @Broadcast({ entity: 'dependency', action: 'update', project: projectOfRow(TaskDependency) })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDependencyDto) {
    return this.dependencyService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @Broadcast({ entity: 'dependency', action: 'delete', project: projectOfRow(TaskDependency) })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.dependencyService.remove(id);
  }
}
