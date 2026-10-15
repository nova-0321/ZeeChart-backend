import { ConflictException, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { RequestTransaction } from '../database/request-transaction.js';
import { rejectNulls } from '../common/reject-nulls.js';
import {
  addOwner,
  membershipOf,
  membershipsOf,
  ownerIdsOf,
  ownsProjectNamed,
} from '../members/membership.js';
import { startHistory } from '../revisions/history-start.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { asMyProject, type MyProjectDto } from './dto/my-project.dto.js';
import { UpdateProjectDto } from './dto/update-project.dto.js';
import { Project } from './entities/project.entity.js';
import { notFound } from '../common/not-found.js';

@Injectable()
export class ProjectsService {
  constructor(private readonly tx: RequestTransaction) {}

  private get projectRepo() {
    return this.tx.repo(Project);
  }

  /** A new project; whoever makes it is its first owner. */
  create(createProjectDto: CreateProjectDto, userId: string): Promise<MyProjectDto> {
    return this.tx.run(async (manager) => {
      await assertNameFree(manager, userId, createProjectDto.name);
      // Version 1: its first revision ("Created project") is written below, with the same number.
      const project = await manager.save(
        manager.create(Project, { ...createProjectDto, version: 1 }),
      );
      // Its first owner, and the start of its history: members and revisions write their own rows,
      // in this transaction.
      const member = await addOwner(manager, project.id, userId);
      await startHistory(
        manager,
        {
          id: project.id,
          name: project.name,
          description: project.description ?? null,
          archived: project.archived,
        },
        userId,
      );
      return asMyProject({ ...member, project, addedBy: null });
    });
  }

  /** Whether the project exists: other domains ask here, before they add a row to it. */
  exists(id: string): Promise<boolean> {
    return this.projectRepo.existsBy({ id });
  }

  /**
   * Holds the project's row until `manager`'s transaction ends, so changes to its members wait for
   * each other (MembersService). 404 when there is no such project.
   */
  async lockForUpdate(manager: EntityManager, id: string): Promise<void> {
    const project = await manager
      .createQueryBuilder(Project, 'project')
      .setLock('pessimistic_write')
      .where('project.id = :id', { id })
      .getOne();
    if (!project) throw notFound('Project');
  }

  /**
   * Before `userId` becomes an owner of the project: they own no other project of its name (see
   * assertNameFree). In `manager`'s transaction. 404 when there is no such project.
   */
  async assertNewOwnerNameFree(manager: EntityManager, id: string, userId: string): Promise<void> {
    const project = await manager.findOneBy(Project, { id });
    if (!project) throw notFound('Project');
    await assertNameFree(
      manager,
      userId,
      project.name,
      id,
      `They already own a project called “${project.name}”: one of the two needs another name first`,
    );
  }

  /** The projects `userId` is a member of, newest first (archived ones included). */
  async findAll(userId: string): Promise<MyProjectDto[]> {
    return (await membershipsOf(this.tx.manager, userId)).map(asMyProject);
  }

  /** One project, with `userId`'s place in it; 404 when they are not a member. */
  async findOne(id: string, userId: string): Promise<MyProjectDto> {
    const membership = await membershipOf(this.tx.manager, id, userId);
    if (!membership) throw notFound('Project');
    return asMyProject(membership);
  }

  async update(id: string, updateProjectDto: UpdateProjectDto, userId: string) {
    // null is no value for a name (the description may be cleared).
    rejectNulls(updateProjectDto, ['description']);
    await this.tx.run(async (manager) => {
      const project = await manager.findOneBy(Project, { id });
      if (!project) throw notFound('Project');
      const { name } = updateProjectDto;
      if (name !== undefined && name !== project.name) {
        // Not only the one renaming it: every owner of it, so none ends up owning two of a name.
        for (const ownerId of await ownerIdsOf(manager, id)) {
          await assertNameFree(
            manager,
            ownerId,
            name,
            id,
            ownerId === userId
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
    if (!project) throw notFound('Project');
    await this.projectRepo.remove(project);
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
  if (await ownsProjectNamed(manager, userId, name, exceptId)) {
    throw new ConflictException(message);
  }
}
