import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, Not, Repository } from 'typeorm';
import { Member } from '../members/entities/member.entity.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { asMyProject, type MyProjectDto } from './dto/my-project.dto.js';
import { UpdateProjectDto } from './dto/update-project.dto.js';
import { Project } from './entities/project.entity.js';

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(Member)
    private readonly memberRepo: Repository<Member>,
    private readonly db: DataSource,
  ) {}

  /** A new project; whoever makes it is its first owner. */
  create(createProjectDto: CreateProjectDto, userId: string): Promise<MyProjectDto> {
    return this.db.transaction(async (manager) => {
      await this.assertNameFree(manager, userId, createProjectDto.name);
      const project = await manager.save(manager.create(Project, createProjectDto));
      const member = await manager.save(
        manager.create(Member, { projectId: project.id, userId, role: 'owner' }),
      );
      return asMyProject({ ...member, project, addedBy: null });
    });
  }

  /** The projects `userId` is a member of, newest first (archived ones included). */
  async findAll(userId: string): Promise<MyProjectDto[]> {
    const memberships = await this.memberRepo.find({
      where: { userId },
      relations: { project: true, addedBy: true },
      order: { project: { createdAt: 'DESC' } },
    });
    return memberships.map(asMyProject);
  }

  /** One project, with `userId`'s place in it; 404 when they are not a member. */
  async findOne(id: string, userId: string): Promise<MyProjectDto> {
    const membership = await this.memberRepo.findOne({
      where: { projectId: id, userId },
      relations: { project: true, addedBy: true },
    });
    if (!membership) throw new NotFoundException(`Project ${id} not found`);
    return asMyProject(membership);
  }

  async update(id: string, updateProjectDto: UpdateProjectDto, userId: string) {
    await this.db.transaction(async (manager) => {
      const project = await manager.findOneBy(Project, { id });
      if (!project) throw new NotFoundException(`Project ${id} not found`);
      const { name } = updateProjectDto;
      if (name !== undefined && name !== project.name) {
        await this.assertNameFree(manager, userId, name, id);
      }
      await manager.save(manager.merge(Project, project, updateProjectDto));
    });
    return this.findOne(id, userId);
  }

  /** Its tasks, links, events and members go with it (ON DELETE CASCADE). */
  async remove(id: string) {
    const project = await this.projectRepo.findOneBy({ id });
    if (!project) throw new NotFoundException(`Project ${id} not found`);
    await this.projectRepo.remove(project);
  }

  archive(id: string, userId: string) {
    return this.setArchived(id, true, userId);
  }

  /** Bring an archived project back to the active list. */
  reopen(id: string, userId: string) {
    return this.setArchived(id, false, userId);
  }

  private async setArchived(id: string, archived: boolean, userId: string) {
    const { affected } = await this.projectRepo.update({ id }, { archived });
    if (!affected) throw new NotFoundException(`Project ${id} not found`);
    return this.findOne(id, userId);
  }

  /**
   * 409 when one of the projects `userId` belongs to (other than `exceptId`) already has this name.
   * Holds a lock on the user until the transaction ends, so two requests at once can't both pass.
   */
  private async assertNameFree(
    manager: EntityManager,
    userId: string,
    name: string,
    exceptId?: string,
  ) {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`project-names:${userId}`]);
    const taken = await manager.exists(Member, {
      where: {
        userId,
        project: { name, ...(exceptId ? { id: Not(exceptId) } : {}) },
      },
      relations: { project: true, addedBy: true },
    });
    if (taken) throw new ConflictException('You already have a project with this name');
  }
}
