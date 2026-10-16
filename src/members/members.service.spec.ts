import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { createHash } from 'node:crypto';
import { CreateInvitationDto } from './dto/create-invitation.dto.js';
import { Invitation } from './entities/invitation.entity.js';
import { Member } from './entities/member.entity.js';
import { roleIn } from './membership.js';
import { INVITE_DAYS, LAST_OWNER, MembersService } from './members.service.js';

// Who is an owner is asked of the members domain (membership.ts): each test says the answer.
vi.mock('./membership.js', () => ({ roleIn: vi.fn() }));

const LINK_GONE = 'This invite link is no longer valid. Ask for a new one';
const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');

const ada = { id: 'u1', name: 'Ada', email: 'ada@x.io' };
const joinedAt = new Date('2026-10-01T09:00:00Z');
const memberRow = (over: Partial<Member> = {}) =>
  ({
    id: 'm1',
    projectId: 'p1',
    userId: 'u1',
    role: 'editor',
    addedById: 'u9',
    joinedAt,
    user: ada,
    ...over,
  }) as Member;
const createdAt = new Date('2026-10-02T09:00:00Z');
const expiresAt = new Date('2026-10-16T09:00:00Z');
const invitationRow = (over: Partial<Invitation> = {}) =>
  ({
    id: 'i1',
    projectId: 'p1',
    email: 'bob@x.io',
    role: 'viewer',
    invitedById: 'u9',
    invitedBy: { name: 'Olive' },
    tokenHash: sha256('old-token'),
    createdAt,
    expiresAt,
    ...over,
  }) as unknown as Invitation;

describe('MembersService', () => {
  let service: MembersService;
  const memberRepo = { find: vi.fn(), findOne: vi.fn() };
  const invitationRepo = {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneBy: vi.fn(),
    delete: vi.fn(),
    createQueryBuilder: vi.fn(),
  };
  // One query builder for every chain: each step answers the builder, execute/getOne the result.
  const qb = {
    delete: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    from: vi.fn(),
    into: vi.fn(),
    values: vi.fn(),
    set: vi.fn(),
    where: vi.fn(),
    andWhere: vi.fn(),
    leftJoinAndSelect: vi.fn(),
    returning: vi.fn(),
    execute: vi.fn(),
    getOne: vi.fn(),
  };
  const manager = {
    existsBy: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    save: vi.fn(),
    findOneBy: vi.fn(),
    countBy: vi.fn(),
    createQueryBuilder: vi.fn(),
  };
  const db = { transaction: vi.fn(), createQueryBuilder: vi.fn() };
  const realtime = { notify: vi.fn(), notifyUser: vi.fn(), removeFromProject: vi.fn() };
  const auth = { findByEmail: vi.fn(), hasAccount: vi.fn() };
  const projects = { lockForUpdate: vi.fn(), assertNewOwnerNameFree: vi.fn() };

  beforeEach(() => {
    vi.resetAllMocks();
    for (const step of Object.keys(qb) as (keyof typeof qb)[]) {
      if (step !== 'execute' && step !== 'getOne') qb[step].mockReturnValue(qb);
    }
    manager.createQueryBuilder.mockReturnValue(qb);
    db.createQueryBuilder.mockReturnValue(qb);
    invitationRepo.createQueryBuilder.mockReturnValue(qb);
    db.transaction.mockImplementation((work: (on: typeof manager) => unknown) => work(manager));
    manager.create.mockImplementation((_: unknown, row: object) => ({ ...row }));
    manager.save.mockImplementation(async (row: object) => ({ id: 'm2', ...row }));
    service = new MembersService(
      memberRepo as never,
      invitationRepo as never,
      db as never,
      realtime as never,
      auth as never,
      projects as never,
    );
  });

  it('lists the members in the order they joined, each with who they are', async () => {
    memberRepo.find.mockResolvedValue([memberRow()]);
    await expect(service.list('p1')).resolves.toEqual([
      {
        id: 'm1',
        projectId: 'p1',
        userId: 'u1',
        name: 'Ada',
        email: 'ada@x.io',
        role: 'editor',
        addedById: 'u9',
        joinedAt,
      },
    ]);
    expect(memberRepo.find).toHaveBeenCalledWith({
      where: { projectId: 'p1' },
      relations: { user: true },
      order: { joinedAt: 'ASC', id: 'ASC' },
    });
  });

  it('lists the pending invitations oldest first, with who invited them', async () => {
    invitationRepo.find.mockResolvedValue([invitationRow(), invitationRow({ invitedBy: null })]);
    const listed = await service.listInvitations('p1');
    expect(listed[0]).toEqual({
      id: 'i1',
      projectId: 'p1',
      email: 'bob@x.io',
      role: 'viewer',
      invitedById: 'u9',
      invitedByName: 'Olive',
      createdAt,
      expiresAt,
    });
    // The inviter's account was deleted.
    expect(listed[1]!.invitedByName).toBeNull();
    expect(invitationRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ order: { createdAt: 'ASC', id: 'ASC' } }),
    );
  });

  // The DTO does it (as on sign-up), so the service always sees one spelling of an email.
  it('an invite email arrives trimmed and lower-cased', () => {
    const dto = plainToInstance(CreateInvitationDto, { email: '  Ada@X.IO ' });
    expect(dto.email).toBe('ada@x.io');
  });

  describe('invite', () => {
    it('adds someone who has an account at once, as an editor, and tells them on their own', async () => {
      auth.hasAccount.mockResolvedValue(true);
      auth.findByEmail.mockResolvedValue(ada);
      manager.existsBy.mockResolvedValue(false);
      memberRepo.findOne.mockResolvedValue(memberRow({ id: 'm2', addedById: 'u9' }));

      const result = await service.invite('p1', { email: 'ada@x.io' }, 'u9');

      expect(result).toMatchObject({ status: 'added', invitation: null, token: null });
      expect(result.member).toMatchObject({ id: 'm2', name: 'Ada' });
      expect(projects.lockForUpdate).toHaveBeenCalledWith(manager, 'p1');
      expect(manager.create).toHaveBeenCalledWith(Member, {
        projectId: 'p1',
        userId: 'u1',
        role: 'editor',
        addedById: 'u9',
      });
      // An invitation for them that was never taken up goes.
      expect(manager.delete).toHaveBeenCalledWith(Invitation, {
        projectId: 'p1',
        email: 'ada@x.io',
      });
      expect(projects.assertNewOwnerNameFree).not.toHaveBeenCalled();
      expect(realtime.notifyUser).toHaveBeenCalledWith('u1', {
        projectId: 'p1',
        entity: 'member',
        action: 'create',
        id: 'm2',
      });
    });

    it('adding someone as an owner checks they own no other project of that name', async () => {
      auth.hasAccount.mockResolvedValue(true);
      auth.findByEmail.mockResolvedValue(ada);
      manager.existsBy.mockResolvedValue(false);
      memberRepo.findOne.mockResolvedValue(memberRow({ role: 'owner' }));

      await service.invite('p1', { email: 'ada@x.io', role: 'owner' }, 'u9');

      expect(projects.assertNewOwnerNameFree).toHaveBeenCalledWith(manager, 'p1', 'u1');
      expect(manager.create).toHaveBeenCalledWith(
        Member,
        expect.objectContaining({ role: 'owner' }),
      );
    });

    it('is a 409 naming them when they already are a member', async () => {
      auth.hasAccount.mockResolvedValue(true);
      auth.findByEmail.mockResolvedValue(ada);
      manager.existsBy.mockResolvedValue(true);

      const error = await service.invite('p1', { email: 'ada@x.io' }, 'u9').catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toBe('Ada is already a member of this project');
      expect(manager.save).not.toHaveBeenCalled();
      expect(realtime.notifyUser).not.toHaveBeenCalled();
    });

    it('add is a 404 when no one has signed up with that email', async () => {
      auth.findByEmail.mockResolvedValue(null);
      await expect(service.add('p1', { email: 'nobody@x.io' }, 'u9')).rejects.toThrow(
        new NotFoundException('No one has signed up with this email'),
      );
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('anyone else gets an invitation: the link token answered once, only its hash stored', async () => {
      auth.hasAccount.mockResolvedValue(false);
      manager.existsBy.mockResolvedValue(false);
      qb.execute
        .mockResolvedValueOnce({ affected: 0 })
        .mockResolvedValueOnce({ raw: [{ id: 'i1' }] });
      invitationRepo.findOne.mockResolvedValue(invitationRow({ role: 'editor' }));

      const result = await service.invite('p1', { email: 'bob@x.io' }, 'u9');

      expect(result.status).toBe('invited');
      expect(result.member).toBeNull();
      expect(result.invitation).toMatchObject({ id: 'i1', email: 'bob@x.io' });
      expect(result.token).toMatch(/^[\w-]{43}$/);
      expect(projects.lockForUpdate).toHaveBeenCalledWith(manager, 'p1');
      // The account check is asked again under the lock, on its connection.
      expect(auth.hasAccount).toHaveBeenLastCalledWith('bob@x.io', manager);

      const values = qb.values.mock.calls[0]![0] as Record<string, unknown>;
      expect(values).toMatchObject({
        projectId: 'p1',
        email: 'bob@x.io',
        role: 'editor',
        invitedById: 'u9',
        tokenHash: sha256(result.token!),
      });
      expect(JSON.stringify(values)).not.toContain(result.token);
      expect((values.expiresAt as () => string)()).toBe(`now() + interval '${INVITE_DAYS} days'`);
      expect(INVITE_DAYS).toBe(14);
      expect(qb.into).toHaveBeenCalledWith(Invitation);
      expect(realtime.notifyUser).not.toHaveBeenCalled();
    });

    it('each invitation gets a different link', async () => {
      auth.hasAccount.mockResolvedValue(false);
      manager.existsBy.mockResolvedValue(false);
      qb.execute.mockResolvedValue({ affected: 0, raw: [{ id: 'i1' }] });
      invitationRepo.findOne.mockResolvedValue(invitationRow());

      const first = await service.invite('p1', { email: 'bob@x.io' }, 'u9');
      const second = await service.invite('p1', { email: 'cy@x.io' }, 'u9');
      expect(first.token).not.toBe(second.token);
    });

    it('an expired invitation for that email is cleared first, so a new one replaces it', async () => {
      auth.hasAccount.mockResolvedValue(false);
      manager.existsBy.mockResolvedValue(false);
      qb.execute
        .mockResolvedValueOnce({ affected: 1 })
        .mockResolvedValueOnce({ raw: [{ id: 'i2' }] });
      invitationRepo.findOne.mockResolvedValue(invitationRow({ id: 'i2' }));

      await service.invite('p1', { email: 'bob@x.io' }, 'u9');

      expect(qb.from).toHaveBeenCalledWith(Invitation);
      expect(qb.where).toHaveBeenCalledWith(expect.stringContaining('"expiresAt" <= now()'), {
        projectId: 'p1',
        email: 'bob@x.io',
      });
      // The clearing ran before the check for one still waiting.
      expect(qb.delete.mock.invocationCallOrder[0]).toBeLessThan(
        manager.existsBy.mock.invocationCallOrder[0]!,
      );
    });

    it('is a 409 naming the email when one is already waiting for it', async () => {
      auth.hasAccount.mockResolvedValue(false);
      manager.existsBy.mockResolvedValue(true);
      qb.execute.mockResolvedValue({ affected: 0 });

      const error = await service.invite('p1', { email: 'bob@x.io' }, 'u9').catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toBe('bob@x.io is already invited to this project');
      expect(qb.insert).not.toHaveBeenCalled();
    });

    // A link gives what it says to whoever opens it: never a whole project.
    it('a link can not make an owner (400), before anything is written', async () => {
      auth.hasAccount.mockResolvedValue(false);
      await expect(
        service.invite('p1', { email: 'bob@x.io', role: 'owner' }, 'u9'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('someone who signed up while it waited for the lock is added instead', async () => {
      auth.hasAccount.mockResolvedValueOnce(false).mockResolvedValue(true);
      auth.findByEmail.mockResolvedValue({ ...ada, email: 'bob@x.io' });
      manager.existsBy.mockResolvedValue(false);
      memberRepo.findOne.mockResolvedValue(memberRow({ id: 'm2' }));

      const result = await service.invite('p1', { email: 'bob@x.io' }, 'u9');

      expect(result).toMatchObject({ status: 'added', invitation: null, token: null });
      expect(qb.insert).not.toHaveBeenCalled();
    });
  });

  describe('changeRole', () => {
    it('is a 404 when the member is not there', async () => {
      manager.findOneBy.mockResolvedValue(null);
      await expect(service.changeRole('m1', 'viewer')).rejects.toThrow(
        new NotFoundException('Member not found'),
      );
      expect(projects.lockForUpdate).not.toHaveBeenCalled();
    });

    it("changes it under the project's lock, reading the member again after the lock", async () => {
      manager.findOneBy.mockResolvedValue(memberRow());
      memberRepo.findOne.mockResolvedValue(memberRow({ role: 'viewer' }));

      await expect(service.changeRole('m1', 'viewer')).resolves.toMatchObject({ role: 'viewer' });

      const [firstRead, secondRead] = manager.findOneBy.mock.invocationCallOrder;
      const lock = projects.lockForUpdate.mock.invocationCallOrder[0]!;
      expect(firstRead).toBeLessThan(lock);
      expect(lock).toBeLessThan(secondRead!);
      expect(projects.lockForUpdate).toHaveBeenCalledWith(manager, 'p1');
      expect(manager.update).toHaveBeenCalledWith(Member, { id: 'm1' }, { role: 'viewer' });
      // What they may do changed: told even where they don't have the project open.
      expect(realtime.notifyUser).toHaveBeenCalledWith('u1', {
        projectId: 'p1',
        entity: 'member',
        action: 'update',
        id: 'm1',
      });
    });

    it('is a 404 when the member was removed while it waited for the lock', async () => {
      manager.findOneBy.mockResolvedValueOnce(memberRow()).mockResolvedValueOnce(null);
      await expect(service.changeRole('m1', 'viewer')).rejects.toThrow(
        new NotFoundException('Member not found'),
      );
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('the last owner can not step down (409)', async () => {
      manager.findOneBy.mockResolvedValue(memberRow({ role: 'owner' }));
      manager.countBy.mockResolvedValue(1);

      await expect(service.changeRole('m1', 'editor')).rejects.toThrow(
        new ConflictException(LAST_OWNER),
      );
      expect(manager.countBy).toHaveBeenCalledWith(Member, { projectId: 'p1', role: 'owner' });
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('an owner can step down while another owner stays', async () => {
      manager.findOneBy.mockResolvedValue(memberRow({ role: 'owner' }));
      manager.countBy.mockResolvedValue(2);
      memberRepo.findOne.mockResolvedValue(memberRow());

      await service.changeRole('m1', 'editor');
      expect(manager.update).toHaveBeenCalledWith(Member, { id: 'm1' }, { role: 'editor' });
    });

    it('making someone an owner checks they own no other project of that name', async () => {
      manager.findOneBy.mockResolvedValue(memberRow());
      memberRepo.findOne.mockResolvedValue(memberRow({ role: 'owner' }));

      await service.changeRole('m1', 'owner');
      expect(projects.assertNewOwnerNameFree).toHaveBeenCalledWith(manager, 'p1', 'u1');
    });

    it('the same role again changes nothing and tells no one', async () => {
      manager.findOneBy.mockResolvedValue(memberRow());
      memberRepo.findOne.mockResolvedValue(memberRow());

      await expect(service.changeRole('m1', 'editor')).resolves.toMatchObject({ role: 'editor' });
      expect(manager.update).not.toHaveBeenCalled();
      expect(realtime.notifyUser).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it("an owner removes someone: deleted, told, and their tabs leave the project's room", async () => {
      manager.findOneBy.mockResolvedValue(memberRow());
      vi.mocked(roleIn).mockResolvedValue('owner');

      await service.remove('m1', 'u9');

      expect(roleIn).toHaveBeenCalledWith(manager, 'p1', 'u9');
      expect(manager.delete).toHaveBeenCalledWith(Member, { id: 'm1' });
      expect(realtime.notifyUser).toHaveBeenCalledWith('u1', {
        projectId: 'p1',
        entity: 'member',
        action: 'delete',
        id: 'm1',
      });
      expect(realtime.removeFromProject).toHaveBeenCalledWith('u1', 'p1');
    });

    it('anyone may leave on their own, without being an owner', async () => {
      manager.findOneBy.mockResolvedValue(memberRow());

      await service.remove('m1', 'u1');

      expect(roleIn).not.toHaveBeenCalled();
      expect(manager.delete).toHaveBeenCalledWith(Member, { id: 'm1' });
      expect(realtime.removeFromProject).toHaveBeenCalledWith('u1', 'p1');
    });

    it("someone who is not an owner can't remove another member (403)", async () => {
      manager.findOneBy.mockResolvedValue(memberRow());
      vi.mocked(roleIn).mockResolvedValue('editor');

      await expect(service.remove('m1', 'u9')).rejects.toBeInstanceOf(ForbiddenException);
      expect(manager.delete).not.toHaveBeenCalled();
      expect(realtime.removeFromProject).not.toHaveBeenCalled();
    });

    it('the last owner can not leave (409)', async () => {
      manager.findOneBy.mockResolvedValue(memberRow({ role: 'owner' }));
      manager.countBy.mockResolvedValue(1);

      await expect(service.remove('m1', 'u1')).rejects.toThrow(new ConflictException(LAST_OWNER));
      expect(manager.delete).not.toHaveBeenCalled();
      expect(realtime.notifyUser).not.toHaveBeenCalled();
    });

    it('an owner may leave while another owner stays', async () => {
      manager.findOneBy.mockResolvedValue(memberRow({ role: 'owner' }));
      manager.countBy.mockResolvedValue(2);

      await service.remove('m1', 'u1');
      expect(manager.delete).toHaveBeenCalledWith(Member, { id: 'm1' });
    });

    it('is a 404 when the member is not there', async () => {
      manager.findOneBy.mockResolvedValue(null);
      await expect(service.remove('m1', 'u1')).rejects.toThrow(
        new NotFoundException('Member not found'),
      );
      expect(realtime.removeFromProject).not.toHaveBeenCalled();
    });

    it('is a 404 when the member left while it waited for the lock', async () => {
      manager.findOneBy.mockResolvedValueOnce(memberRow()).mockResolvedValueOnce(null);
      await expect(service.remove('m1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
      expect(manager.delete).not.toHaveBeenCalled();
    });
  });

  describe('cancelInvitation', () => {
    it('deletes the invitation', async () => {
      invitationRepo.delete.mockResolvedValue({ affected: 1 });
      await service.cancelInvitation('i1');
      expect(invitationRepo.delete).toHaveBeenCalledWith({ id: 'i1' });
    });

    it('is a 404 when there is no such invitation', async () => {
      invitationRepo.delete.mockResolvedValue({ affected: 0 });
      await expect(service.cancelInvitation('i1')).rejects.toThrow(
        new NotFoundException('Invitation not found'),
      );
    });
  });

  describe('renewLink', () => {
    it('makes a new link (only its hash stored), by this owner, for another INVITE_DAYS days', async () => {
      qb.execute.mockResolvedValue({ affected: 1 });
      invitationRepo.findOne.mockResolvedValue(invitationRow({ invitedById: 'u7' }));

      const result = await service.renewLink('i1', 'u7');

      expect(result.token).toMatch(/^[\w-]{43}$/);
      expect(result.invitation).toMatchObject({ id: 'i1', invitedById: 'u7' });
      expect(qb.update).toHaveBeenCalledWith(Invitation);
      const change = qb.set.mock.calls[0]![0] as Record<string, unknown>;
      expect(change.tokenHash).toBe(sha256(result.token));
      expect(change.tokenHash).not.toBe(sha256('old-token'));
      expect(change.invitedById).toBe('u7');
      expect((change.expiresAt as () => string)()).toBe(`now() + interval '${INVITE_DAYS} days'`);
      expect(qb.where).toHaveBeenCalledWith('id = :id', { id: 'i1' });
    });

    it('is a 404 when there is no such invitation', async () => {
      qb.execute.mockResolvedValue({ affected: 0 });
      await expect(service.renewLink('i1', 'u7')).rejects.toThrow(
        new NotFoundException('Invitation not found'),
      );
    });

    it('is a 404 when the invitation went just after it was renewed', async () => {
      qb.execute.mockResolvedValue({ affected: 1 });
      invitationRepo.findOne.mockResolvedValue(null);
      await expect(service.renewLink('i1', 'u7')).rejects.toThrow(
        new NotFoundException('Invitation not found'),
      );
    });
  });

  describe('preview', () => {
    const withProject = (over: Partial<Invitation> = {}) =>
      invitationRow({ project: { name: 'Launch' }, ...over } as never);

    it('says what a live link is for, looked up by the hash of its token', async () => {
      qb.getOne.mockResolvedValue(withProject());
      vi.mocked(roleIn).mockResolvedValue('owner');

      await expect(service.preview('tok')).resolves.toEqual({
        projectName: 'Launch',
        invitedByName: 'Olive',
        role: 'viewer',
        expiresAt,
      });
      expect(qb.where).toHaveBeenCalledWith('invitation.tokenHash = :hash', {
        hash: sha256('tok'),
      });
      expect(qb.andWhere).toHaveBeenCalledWith('invitation.expiresAt > now()');
      expect(roleIn).toHaveBeenCalledWith(db, 'p1', 'u9');
    });

    it('answers no inviter name once their account is gone', async () => {
      qb.getOne.mockResolvedValue(withProject({ invitedBy: null } as never));
      vi.mocked(roleIn).mockResolvedValue('owner');
      await expect(service.preview('tok')).resolves.toMatchObject({ invitedByName: null });
    });

    it('is a 404 for an unknown or expired link', async () => {
      // The query leaves out expired ones, so both come back as nothing.
      qb.getOne.mockResolvedValue(null);
      await expect(service.preview('tok')).rejects.toThrow(new NotFoundException(LINK_GONE));
    });

    it('is a 404 when its inviter is no longer an owner, or no longer has an account', async () => {
      qb.getOne.mockResolvedValue(withProject());
      vi.mocked(roleIn).mockResolvedValue('editor');
      await expect(service.preview('tok')).rejects.toThrow(new NotFoundException(LINK_GONE));

      qb.getOne.mockResolvedValue(withProject({ invitedById: null }));
      await expect(service.preview('tok')).rejects.toThrow(new NotFoundException(LINK_GONE));
    });
  });

  describe('accept', () => {
    beforeEach(() => {
      invitationRepo.findOneBy.mockResolvedValue(invitationRow());
      manager.existsBy.mockResolvedValue(false);
      qb.execute.mockResolvedValue({ affected: 1 });
      vi.mocked(roleIn).mockResolvedValue('owner');
    });

    it("adds them with the invitation's role, added by the inviter, and uses the link up", async () => {
      await expect(service.accept('old-token', 'u5')).resolves.toEqual({
        projectId: 'p1',
        alreadyMember: false,
      });

      expect(invitationRepo.findOneBy).toHaveBeenCalledWith({ tokenHash: sha256('old-token') });
      expect(projects.lockForUpdate).toHaveBeenCalledWith(manager, 'p1');
      expect(qb.from).toHaveBeenCalledWith(Invitation);
      expect(qb.where).toHaveBeenCalledWith(expect.stringContaining('"expiresAt" > now()'), {
        id: 'i1',
        hash: sha256('old-token'),
      });
      expect(roleIn).toHaveBeenCalledWith(manager, 'p1', 'u9');
      expect(manager.create).toHaveBeenCalledWith(Member, {
        projectId: 'p1',
        userId: 'u5',
        role: 'viewer',
        addedById: 'u9',
      });
      // The others see a new member, and the invitation gone.
      expect(realtime.notify).toHaveBeenCalledWith({
        projectId: 'p1',
        entity: 'member',
        action: 'create',
        id: 'm2',
      });
      expect(realtime.notify).toHaveBeenCalledWith({
        projectId: 'p1',
        entity: 'invitation',
        action: 'delete',
        id: 'i1',
      });
    });

    it('someone already a member is answered so, and the link is left for the one it is for', async () => {
      manager.existsBy.mockResolvedValue(true);

      await expect(service.accept('old-token', 'u5')).resolves.toEqual({
        projectId: 'p1',
        alreadyMember: true,
      });
      expect(qb.delete).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
      expect(realtime.notify).not.toHaveBeenCalled();
    });

    it('is a 404 for an unknown link', async () => {
      invitationRepo.findOneBy.mockResolvedValue(null);
      await expect(service.accept('tok', 'u5')).rejects.toThrow(new NotFoundException(LINK_GONE));
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('is a 404 for a link that expired, or was taken up or renewed meanwhile', async () => {
      qb.execute.mockResolvedValue({ affected: 0 });
      await expect(service.accept('old-token', 'u5')).rejects.toThrow(
        new NotFoundException(LINK_GONE),
      );
      expect(manager.save).not.toHaveBeenCalled();
      expect(realtime.notify).not.toHaveBeenCalled();
    });

    it('is a 404 when its inviter is no longer an owner', async () => {
      vi.mocked(roleIn).mockResolvedValue(null);
      await expect(service.accept('old-token', 'u5')).rejects.toThrow(
        new NotFoundException(LINK_GONE),
      );
      expect(manager.save).not.toHaveBeenCalled();
    });

    it("is a 404 when its inviter's account is gone", async () => {
      invitationRepo.findOneBy.mockResolvedValue(invitationRow({ invitedById: null }));
      await expect(service.accept('old-token', 'u5')).rejects.toThrow(
        new NotFoundException(LINK_GONE),
      );
      expect(roleIn).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });
  });
});
