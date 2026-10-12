import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, type EntityManager, Repository } from 'typeorm';
import { User } from '../auth/entities/user.entity.js';
import { Project } from '../projects/entities/project.entity.js';
import { roleIn } from '../projects/project-access.js';
import { assertNameFree } from '../projects/projects.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { AddMemberDto } from './dto/add-member.dto.js';
import {
  asInvitationDto,
  type InvitationDto,
  type InviteLinkDto,
  type InvitePreviewDto,
  type InviteResultDto,
} from './dto/invitation.dto.js';
import { asMemberDto, type MemberDto } from './dto/member.dto.js';
import { Invitation } from './entities/invitation.entity.js';
import { Member } from './entities/member.entity.js';
import type { MemberRole } from './member-role.js';

/** How long an invite link works. */
export const INVITE_DAYS = 14;

const LINK_GONE = 'This invite link is no longer valid. Ask for a new one';

const OWNER_LINK =
  'An invite link can make someone an editor or a viewer. Make them an owner from the members list once they have joined';

/** A secret for an invite link: 32 random bytes, URL-safe. */
const newToken = () => randomBytes(32).toString('base64url');

/** What is stored of a link's secret (the secret itself is never stored). */
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

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
    @InjectRepository(Invitation)
    private readonly invitationRepo: Repository<Invitation>,
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
      // An invitation for them that was never taken up has no use any more.
      await manager.delete(Invitation, { projectId, email: user.email });
      const role = dto.role ?? 'editor';
      if (role === 'owner') await assertOwnsNoSameName(manager, projectId, user.id);
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
      if (role === 'owner') await assertOwnsNoSameName(manager, found.projectId, found.userId);
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
  async remove(id: string, byUserId: string): Promise<void> {
    const member = await this.db.transaction(async (manager) => {
      const found = await lockedMember(manager, id);
      // Someone else's place: an owner's to take away. Your own: yours to leave.
      if (
        found.userId !== byUserId &&
        (await roleIn(this.db, found.projectId, byUserId)) !== 'owner'
      ) {
        throw new ForbiddenException('Only an owner of this project can do this');
      }
      if (found.role === 'owner') await assertAnotherOwner(manager, found);
      await manager.delete(Member, { id });
      return found;
    });
    const { userId, projectId } = member;
    this.realtime.notifyUser(userId, { projectId, entity: 'member', action: 'delete', id });
    await this.realtime.removeFromProject(userId, projectId);
  }

  /**
   * Invites someone by email: added at once when they have an account (as `add`); otherwise an
   * invitation is kept, and the answer carries its secret link (`token`, shown this once): whoever
   * opens it signs up or in and joins. The email only says who it is for. 409 when one is already
   * waiting for that email.
   */
  async invite(
    projectId: string,
    dto: AddMemberDto,
    invitedById: string,
  ): Promise<InviteResultDto> {
    const added = async (): Promise<InviteResultDto> => ({
      status: 'added',
      member: await this.add(projectId, dto, invitedById),
      invitation: null,
      token: null,
    });
    if (await this.userRepo.existsBy({ email: dto.email })) return added();
    // A link gives what it says to whoever opens it, so never a whole project: owners are made
    // from the members list once they have joined.
    if (dto.role === 'owner') throw new BadRequestException(OWNER_LINK);
    const token = newToken();
    const id = await this.db.transaction(async (manager) => {
      await lockProject(manager, projectId);
      // They signed up a moment ago: add them instead.
      if (await manager.existsBy(User, { email: dto.email })) return null;
      // One whose link has expired doesn't count: replaced by this one.
      await manager
        .createQueryBuilder()
        .delete()
        .from(Invitation)
        .where('"projectId" = :projectId AND email = :email AND "expiresAt" <= now()', {
          projectId,
          email: dto.email,
        })
        .execute();
      if (await manager.existsBy(Invitation, { projectId, email: dto.email })) {
        throw new ConflictException(`${dto.email} is already invited to this project`);
      }
      const result = await manager
        .createQueryBuilder()
        .insert()
        .into(Invitation)
        .values({
          projectId,
          email: dto.email,
          role: dto.role ?? 'editor',
          invitedById,
          tokenHash: hashOf(token),
          expiresAt: () => `now() + interval '${INVITE_DAYS} days'`,
        })
        .returning('id')
        .execute();
      return (result.raw as { id: string }[])[0]!.id;
    });
    if (id === null) return added();
    return { status: 'invited', member: null, invitation: await this.findInvitation(id), token };
  }

  /** The project's pending invitations, oldest first. */
  async listInvitations(projectId: string): Promise<InvitationDto[]> {
    const invitations = await this.invitationRepo.find({
      where: { projectId },
      relations: { invitedBy: true },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    return invitations.map(asInvitationDto);
  }

  async cancelInvitation(id: string): Promise<void> {
    const { affected } = await this.invitationRepo.delete({ id });
    if (!affected) throw new NotFoundException('Not found');
  }

  /**
   * A new secret link for a pending invitation (the old one stops working), valid for another
   * INVITE_DAYS days. Only the link's hash is stored, so a lost link can't be shown again: this is
   * how an owner gets one to pass on.
   */
  async renewLink(id: string, ownerId: string): Promise<InviteLinkDto> {
    const token = newToken();
    // Made by this owner now (whoever invited first may be gone, which would leave the link dead).
    const result = await this.db
      .createQueryBuilder()
      .update(Invitation)
      .set({
        tokenHash: hashOf(token),
        invitedById: ownerId,
        expiresAt: () => `now() + interval '${INVITE_DAYS} days'`,
      })
      .where('id = :id', { id })
      .execute();
    if (!result.affected) throw new NotFoundException('Not found');
    return { token, invitation: await this.findInvitation(id) };
  }

  /** What an invite link is for (shown before signing in): 404 when it is unknown or expired. */
  async preview(token: string): Promise<InvitePreviewDto> {
    const invitation = await this.invitationRepo
      .createQueryBuilder('invitation')
      .leftJoinAndSelect('invitation.project', 'project')
      .leftJoinAndSelect('invitation.invitedBy', 'invitedBy')
      .where('invitation.tokenHash = :hash', { hash: hashOf(token) })
      .andWhere('invitation.expiresAt > now()')
      .getOne();
    // The same as accept: one made by someone who is no longer an owner gives nothing.
    if (
      !invitation?.invitedById ||
      (await roleIn(this.db, invitation.projectId, invitation.invitedById)) !== 'owner'
    ) {
      throw new NotFoundException(LINK_GONE);
    }
    return {
      projectName: invitation.project.name,
      invitedByName: invitation.invitedBy?.name ?? null,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * Takes up an invite link for the signed-in person: they become a member with its role (added by
   * whoever invited them), and the link is used up. Someone who already is a member just uses it up.
   * 404 when the link is unknown, expired, or its inviter is no longer an owner of the project.
   */
  async accept(
    token: string,
    userId: string,
  ): Promise<{ projectId: string; alreadyMember: boolean }> {
    const found = await this.invitationRepo.findOneBy({ tokenHash: hashOf(token) });
    if (!found) throw new NotFoundException(LINK_GONE);
    const memberId = await this.db.transaction(async (manager) => {
      await lockProject(manager, found.projectId);
      // Already in (an owner trying their own link, or someone it was forwarded to): the link is
      // left for the person it is for.
      if (await manager.existsBy(Member, { projectId: found.projectId, userId })) return null;
      // Taken up, cancelled or renewed meanwhile; or expired: only one may use it, while it lasts.
      const { affected } = await manager
        .createQueryBuilder()
        .delete()
        .from(Invitation)
        .where('id = :id AND "tokenHash" = :hash AND "expiresAt" > now()', {
          id: found.id,
          hash: found.tokenHash,
        })
        .execute();
      if (!affected) throw new NotFoundException(LINK_GONE);
      // Only an owner's invitation counts: one made by someone who has since been removed or is no
      // longer an owner gives nothing.
      if (
        !found.invitedById ||
        (await roleIn(manager, found.projectId, found.invitedById)) !== 'owner'
      ) {
        throw new NotFoundException(LINK_GONE);
      }
      const saved = await manager.save(
        manager.create(Member, {
          projectId: found.projectId,
          userId,
          role: found.role,
          addedById: found.invitedById,
        }),
      );
      return saved.id;
    });
    if (memberId) {
      // The others in the project see a new member, and the invitation gone.
      this.realtime.notify({
        projectId: found.projectId,
        entity: 'member',
        action: 'create',
        id: memberId,
      });
      this.realtime.notify({
        projectId: found.projectId,
        entity: 'invitation',
        action: 'delete',
        id: found.id,
      });
    }
    return { projectId: found.projectId, alreadyMember: memberId === null };
  }

  private async findInvitation(id: string): Promise<InvitationDto> {
    const invitation = await this.invitationRepo.findOne({
      where: { id },
      relations: { invitedBy: true },
    });
    if (!invitation) throw new NotFoundException('Not found');
    return asInvitationDto(invitation);
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

/** Before someone becomes an owner of a project: they own no other project of its name. */
const assertOwnsNoSameName = async (manager: EntityManager, projectId: string, userId: string) => {
  const project = await manager.findOneBy(Project, { id: projectId });
  if (!project) throw new NotFoundException('Not found');
  await assertNameFree(
    manager,
    userId,
    project.name,
    projectId,
    `They already own a project called “${project.name}”: one of the two needs another name first`,
  );
};
