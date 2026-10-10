import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { UpdateProjectDto } from './dto/update-project.dto.js';
import { Project } from './entities/project.entity.js';

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
  ) {}

  /** A new project, owned by `ownerId`. */
  create(createProjectDto: CreateProjectDto, ownerId: string) {
    return this.projectRepo.save(this.projectRepo.create({ ...createProjectDto, ownerId }));
  }

  /** The projects of one owner, newest first (archived ones included). */
  findAll(ownerId: string) {
    return this.projectRepo.find({ where: { ownerId }, order: { createdAt: 'DESC' } });
  }

  async findOne(id: string) {
    const project = await this.projectRepo.findOneBy({ id });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    return project;
  }

  async update(id: string, updateProjectDto: UpdateProjectDto) {
    const project = await this.findOne(id);
    return this.projectRepo.save(this.projectRepo.merge(project, updateProjectDto));
  }

  async remove(id: string) {
    const project = await this.findOne(id);
    await this.projectRepo.remove(project);
  }

  archive(id: string) {
    return this.setArchived(id, true);
  }

  /** Bring an archived project back to the active list. */
  reopen(id: string) {
    return this.setArchived(id, false);
  }

  private async setArchived(id: string, archived: boolean) {
    const project = await this.findOne(id);
    project.archived = archived;
    return this.projectRepo.save(project);
  }
}
