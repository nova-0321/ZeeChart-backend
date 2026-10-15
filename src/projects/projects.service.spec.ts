import { NotFoundException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { RequestTransaction } from '../database/request-transaction.js';
import { Member } from '../members/entities/member.entity.js';
import { Project } from './entities/project.entity.js';
import { ProjectsService } from './projects.service.js';

// Creating and renaming (transactions, the name check) are tested end to end
// (test/ownership.e2e-spec.ts).
describe('ProjectsService', () => {
  let service: ProjectsService;
  const projectRepo = { findOneBy: vi.fn(), remove: vi.fn(), update: vi.fn(), existsBy: vi.fn() };
  // Memberships are read through the members domain (membership.ts), on the request's manager.
  const manager = { find: vi.fn(), findOne: vi.fn() };
  // A write's own transaction (RequestTransaction.run): reads the row, merges the change, saves.
  const write = { findOneBy: vi.fn(), merge: vi.fn(), save: vi.fn() };

  beforeEach(async () => {
    vi.resetAllMocks();
    write.merge.mockImplementation((_: unknown, row: object, change: object) => ({
      ...row,
      ...change,
    }));
    write.save.mockImplementation(async (row: unknown) => row);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        {
          provide: RequestTransaction,
          useValue: {
            repo: () => projectRepo,
            manager,
            run: (work: (on: typeof write) => unknown) => work(write),
          },
        },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  const launch = { id: 'p1', name: 'Launch', archived: false, tasks: [{ id: 't1' }] };

  it('lists the projects you are a member of, each with your place in it, without relations', async () => {
    const joinedAt = new Date('2026-10-01T09:00:00Z');
    manager.find.mockResolvedValue([
      {
        role: 'editor',
        joinedAt,
        project: launch,
        addedBy: { id: 'u2', name: 'Olive', email: 'olive@example.com' },
      },
    ]);
    await expect(service.findAll('u1')).resolves.toEqual([
      {
        id: 'p1',
        name: 'Launch',
        archived: false,
        role: 'editor',
        joinedAt,
        addedBy: { id: 'u2', name: 'Olive' },
      },
    ]);
    expect(manager.find).toHaveBeenCalledWith(
      Member,
      expect.objectContaining({ where: { userId: 'u1' } }),
    );
  });

  it('findOne is a 404 for someone who is not a member', async () => {
    manager.findOne.mockResolvedValue(null);
    await expect(service.findOne('p1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  // The one way to archive and reopen (#57: the /archive and /reopen routes are gone).
  it('update archives and reopens (archived), and answers the project with your role', async () => {
    write.findOneBy.mockResolvedValue({ ...launch });
    manager.findOne.mockResolvedValue({ role: 'owner', project: launch, addedBy: null });

    await expect(service.update('p1', { archived: true }, 'u1')).resolves.toMatchObject({
      role: 'owner',
    });
    expect(write.save).toHaveBeenLastCalledWith(expect.objectContaining({ archived: true }));
    await service.update('p1', { archived: false }, 'u1');
    expect(write.save).toHaveBeenLastCalledWith(expect.objectContaining({ archived: false }));
  });

  it('update is a 404 for a project that does not exist', async () => {
    write.findOneBy.mockResolvedValue(null);
    await expect(service.update('p1', { archived: true }, 'u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // Tasks and events ask this before adding a row to a project (#55).
  it('exists says whether that project is there', async () => {
    projectRepo.existsBy.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve(id === 'p1'),
    );
    await expect(service.exists('p1')).resolves.toBe(true);
    await expect(service.exists('p2')).resolves.toBe(false);
  });

  // MembersService runs these in its own transactions, on its manager (#55).
  describe('for member changes', () => {
    const query = { setLock: vi.fn(), where: vi.fn(), getOne: vi.fn() };
    const manager = { createQueryBuilder: vi.fn(), findOneBy: vi.fn() };

    beforeEach(() => {
      query.setLock.mockReturnValue(query);
      query.where.mockReturnValue(query);
      manager.createQueryBuilder.mockReturnValue(query);
    });

    it("lockForUpdate holds the project's row (FOR UPDATE) on that manager", async () => {
      query.getOne.mockResolvedValue(launch);
      await service.lockForUpdate(manager as never, 'p1');
      expect(manager.createQueryBuilder).toHaveBeenCalledWith(Project, 'project');
      expect(query.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(query.where).toHaveBeenCalledWith('project.id = :id', { id: 'p1' });
    });

    it('lockForUpdate is a 404 for a project that is gone', async () => {
      query.getOne.mockResolvedValue(null);
      await expect(service.lockForUpdate(manager as never, 'p1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('assertNewOwnerNameFree is a 404 for a project that is gone', async () => {
      manager.findOneBy.mockResolvedValue(null);
      await expect(
        service.assertNewOwnerNameFree(manager as never, 'p1', 'u2'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
