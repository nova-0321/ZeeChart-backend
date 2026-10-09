import { Controller, Get, Post, Body, Patch, Param, Delete, ParseUUIDPipe } from '@nestjs/common';
import { Broadcast, NoBroadcast, projectInParam } from '../realtime/broadcast.decorator.js';
import { ProjectsService } from './projects.service.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { UpdateProjectDto } from './dto/update-project.dto.js';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  // Only the owner changes the project list, and a new project has no one in its room yet.
  @Post()
  @NoBroadcast('a new project has no one in its room')
  create(@Body() createProjectDto: CreateProjectDto) {
    return this.projectsService.create(createProjectDto);
  }

  @Get()
  findAll() {
    return this.projectsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectsService.findOne(id);
  }

  @Patch(':id')
  @Broadcast({ entity: 'project', action: 'update', project: projectInParam() })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() updateProjectDto: UpdateProjectDto) {
    return this.projectsService.update(id, updateProjectDto);
  }

  @Patch(':id/archive')
  @Broadcast({ entity: 'project', action: 'update', project: projectInParam() })
  archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectsService.archive(id);
  }

  @Patch(':id/reopen')
  @Broadcast({ entity: 'project', action: 'update', project: projectInParam() })
  reopen(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectsService.reopen(id);
  }

  // Tells whoever has it open, so they can move off it.
  @Delete(':id')
  @Broadcast({ entity: 'project', action: 'delete', project: projectInParam() })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.projectsService.remove(id);
  }
}
