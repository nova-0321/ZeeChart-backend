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
  projectInBody,
  projectInQuery,
  projectOfRow,
  ProjectOwnerGuard,
} from '../projects/project-access.js';
import { Broadcast } from '../realtime/broadcast.decorator.js';
import { CreateEventDto } from './dto/create-event.dto.js';
import { UpdateEventDto } from './dto/update-event.dto.js';
import { ProjectEvent } from './entities/project-event.entity.js';
import { EventsService } from './events.service.js';

// Each write route says who may make the change (@OwnedProject: the project's owner, 404 for
// anyone else) and who is told after it (@Broadcast: everyone with the project open).
@Controller('events')
@UseGuards(AuthGuard, ProjectOwnerGuard)
@ApiBearerAuth()
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  /** The events of a project, earliest first. */
  @Get()
  @OwnedProject(projectInQuery())
  findByProject(@Query('projectId', ParseUUIDPipe) projectId: string) {
    return this.eventsService.findByProject(projectId);
  }

  @Post()
  @OwnedProject(projectInBody())
  @Broadcast({ entity: 'event', action: 'create', project: projectInBody() })
  create(@Body() dto: CreateEventDto) {
    return this.eventsService.create(dto);
  }

  /** Change any of name, color and dates. */
  @Patch(':id')
  @OwnedProject(projectOfRow(ProjectEvent))
  @Broadcast({ entity: 'event', action: 'update', project: projectOfRow(ProjectEvent) })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEventDto) {
    return this.eventsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @OwnedProject(projectOfRow(ProjectEvent))
  @Broadcast({ entity: 'event', action: 'delete', project: projectOfRow(ProjectEvent) })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.eventsService.remove(id);
  }
}
