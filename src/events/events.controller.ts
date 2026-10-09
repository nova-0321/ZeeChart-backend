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
import { CreateEventDto } from './dto/create-event.dto.js';
import { UpdateEventDto } from './dto/update-event.dto.js';
import { Broadcast, projectInBody, projectOfRow } from '../realtime/broadcast.decorator.js';
import { ProjectEvent } from './entities/project-event.entity.js';
import { EventsService } from './events.service.js';

@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  /** The events of a project, earliest first. */
  @Get()
  findByProject(@Query('projectId', ParseUUIDPipe) projectId: string) {
    return this.eventsService.findByProject(projectId);
  }

  @Post()
  @Broadcast({ entity: 'event', action: 'create', project: projectInBody() })
  create(@Body() dto: CreateEventDto) {
    return this.eventsService.create(dto);
  }

  /** Change any of name, color and dates. */
  @Patch(':id')
  @Broadcast({ entity: 'event', action: 'update', project: projectOfRow(ProjectEvent) })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEventDto) {
    return this.eventsService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @Broadcast({ entity: 'event', action: 'delete', project: projectOfRow(ProjectEvent) })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.eventsService.remove(id);
  }
}
