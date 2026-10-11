import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, Repository } from 'typeorm';
import { User } from '../auth/entities/user.entity.js';
import { Project } from '../projects/entities/project.entity.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { AddMemberDto } from './dto/add-member.dto.js';
import { asMemberDto, type MemberDto } from './dto/member.dto.js';
import { Member } from './entities/member.entity.js';
import type { MemberRole } from './member-role.js';

export const LAST_OWNER = 'A project needs at least one owner. Make someone else an owner first';

/**
 * Who is in a project, and their roles. A project always keeps at least one owner: the last one
 * can't be demoted or removed. Changes to one project's members wait for each other (a lock on
 * the project's row), so two owners demoting each other at once can't leave it with none.
 */
@Injectable()
export class MembersService {
  constructor(
    @InjectRepository(Member)
    private readonly memberRepo: Repository<Member>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly db: DataSource,
    private readonly realtime: RealtimeService,
  ) {}

  /** The members of a project, in the order they joined. */
  async list(projectId: string): Promise<MemberDto[]> {
    const members = await this.memberRepo.find({
      where: { projectId },
      relations: { user: true },
      order: { joinedAt: 'ASC', id: 'ASC' },
    });
    return members.map(asMemberDto);
  }

  /** Adds someone who has an account (found by email), as an editor unless told otherwise. */
  async add(projectId: string, dto: AddMemberDto, addedById: string): Promise<MemberDto> {
    const user = await this.userRepo.findOneBy({ email: dto.email });
    if (!user) throw new NotFoundException('No one has signed up with this email');
    const id = await this.db.transaction(async (manager) => {
      await lockProject(manager, projectId);
      if (await manager.existsBy(Member, { projectId, userId: user.id })) {
        throw new ConflictException(`${user.name} is already a member of this project`);
      }
      const role = dto.role ?? 'editor';
      const saved = await manager.save(
        manager.create(Member, { projectId, userId: user.id, role, addedById }),
      );
      return saved.id;
    });
    // They aren't in the project's room yet: told on their own.
    this.realtime.notifyUser(user.id, { projectId, entity: 'member', action: 'create', id });
    return this.findOne(id);
  }

  async changeRole(id: string, role: MemberRole): Promise<MemberDto> {
    const member = await this.db.transaction(async (manager) => {
      const found = await lockedMember(manager, id);
      if (found.role === role) return null;
      if (found.role === 'owner') await assertAnotherOwner(manager, found);
      await manager.update(Member, { id }, { role });
      return found;
    });
    // What they may do changed, even in a project they don't have open.
    if (member) {
      this.realtime.notifyUser(member.userId, {
        projectId: member.projectId,
        entity: 'member',
        action: 'update',
        id,
      });
    }
    return this.findOne(id);
  }

  /** Their tabs leave the project's room at once: they hear nothing more about it. */
  async remove(id: string): Promise<void> {
    const member = await this.db.transaction(async (manager) => {
      const found = await lockedMember(manager, id);
      if (found.role === 'owner') await assertAnotherOwner(manager, found);
      await manager.delete(Member, { id });
      return found;
    });
    const { userId, projectId } = member;
    this.realtime.notifyUser(userId, { projectId, entity: 'member', action: 'delete', id });
    await this.realtime.removeFromProject(userId, projectId);
  }

  private async findOne(id: string): Promise<MemberDto> {
    const member = await this.memberRepo.findOne({ where: { id }, relations: { user: true } });
    if (!member) throw new NotFoundException('Not found');
    return asMemberDto(member);
  }
}

/** Holds the project's row until the transaction ends: member changes to it wait for each other. */
const lockProject = async (manager: EntityManager, projectId: string) => {
  const project = await manager
    .createQueryBuilder(Project, 'project')
    .setLock('pessimistic_write')
    .where('project.id = :projectId', { projectId })
    .getOne();
  if (!project) throw new NotFoundException('Not found');
};

/** A member read under its project's lock, so its role can't change before the transaction ends. */
const lockedMember = async (manager: EntityManager, id: string) => {
  const before = await manager.findOneBy(Member, { id });
  if (!before) throw new NotFoundException('Not found');
  await lockProject(manager, before.projectId);
  // Read again: another change may have finished while this one waited for the lock.
  const member = await manager.findOneBy(Member, { id });
  if (!member) throw new NotFoundException('Not found');
  return member;
};

const assertAnotherOwner = async (manager: EntityManager, member: Member) => {
  const owners = await manager.countBy(Member, { projectId: member.projectId, role: 'owner' });
  if (owners <= 1) throw new ConflictException(LAST_OWNER);
};
