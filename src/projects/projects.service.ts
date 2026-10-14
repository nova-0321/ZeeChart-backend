import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type EntityManager, Not } from 'typeorm';
import { RequestTransaction } from '../database/request-transaction.js';
import { rejectNulls } from '../common/reject-nulls.js';
import { Member } from '../members/entities/member.entity.js';
import { ProjectVersion } from '../revisions/entities/project-version.entity.js';
import { Revision } from '../revisions/entities/revision.entity.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { asMyProject, type MyProjectDto } from './dto/my-project.dto.js';
import { UpdateProjectDto } from './dto/update-project.dto.js';
import { Project } from './entities/project.entity.js';

@Injectable()
export class ProjectsService {
  constructor(private readonly tx: RequestTransaction) {}

  private get projectRepo() {
    return this.tx.repo(Project);
  }

  private get memberRepo() {
    return this.tx.repo(Member);
  }

  /** A new project; whoever makes it is its first owner. */
  create(createProjectDto: CreateProjectDto, userId: string): Promise<MyProjectDto> {
    return this.tx.run(async (manager) => {
      await assertNameFree(manager, userId, createProjectDto.name);
      // Version 1: its first revision ("Created project") is written below, with the same number.
      const project = await manager.save(
        manager.create(Project, { ...createProjectDto, version: 1 }),
      );
      const member = await manager.save(
        manager.create(Member, { projectId: project.id, userId, role: 'owner' }),
      );
      // The first line of its history (later changes are recorded by RevisionInterceptor).
      const state = {
        id: project.id,
        name: project.name,
        description: project.description ?? null,
        archived: project.archived,
      };
      await manager.save(
        manager.create(Revision, {
          projectId: project.id,
          entityType: 'project',
          entityId: project.id,
          version: 1,
          action: 'create',
          changedById: userId,
          summary: `Created project “${project.name}”`,
          before: null,
          after: state,
          batchId: randomUUID(),
          primary: true,
        }),
      );
      // And its first version, v1 (empty): later ones are saved as it changes.
      await manager.save(
        manager.create(ProjectVersion, {
          projectId: project.id,
          number: 1,
          kind: 'auto',
          content: { project: state, tasks: [], events: [], links: [] },
          createdById: userId,
        }),
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
    // null is no value for a name (the description may be cleared).
    rejectNulls(updateProjectDto, ['description']);
    await this.tx.run(async (manager) => {
      const project = await manager.findOneBy(Project, { id });
      if (!project) throw new NotFoundException(`Project ${id} not found`);
      const { name } = updateProjectDto;
      if (name !== undefined && name !== project.name) {
        // Not only the one renaming it: every owner of it, so none ends up owning two of a name.
        const owners = await manager.find(Member, {
          select: { userId: true },
          where: { projectId: id, role: 'owner' },
          order: { userId: 'ASC' },
        });
        for (const owner of owners) {
          await assertNameFree(
            manager,
            owner.userId,
            name,
            id,
            owner.userId === userId
              ? undefined
              : 'Another owner of this project already has a project with this name',
          );
        }
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
}

/**
 * 409 when one of the projects `userId` owns (other than `exceptId`) already has this name: names
 * are unique among the projects one owns (one shared with them may have any name; their list tells
 * it apart by who invited them). Holds a lock on the user until the transaction ends, so two
 * requests at once can't both pass. Also used when someone becomes an owner (MembersService).
 */
export async function assertNameFree(
  manager: EntityManager,
  userId: string,
  name: string,
  exceptId?: string,
  message = 'You already have a project with this name',
) {
  await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`project-names:${userId}`]);
  const taken = await manager.exists(Member, {
    where: {
      userId,
      role: 'owner',
      project: { name, ...(exceptId ? { id: Not(exceptId) } : {}) },
    },
    relations: { project: true },
  });
  if (taken) throw new ConflictException(message);
}
