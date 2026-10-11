import { NotFoundException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Member } from '../members/entities/member.entity.js';
import { Project } from './entities/project.entity.js';
import { ProjectsService } from './projects.service.js';

// Creating and renaming (transactions, the name check) are tested end to end
// (test/ownership.e2e-spec.ts).
describe('ProjectsService', () => {
  let service: ProjectsService;
  const projectRepo = { findOneBy: vi.fn(), remove: vi.fn(), update: vi.fn() };
  const memberRepo = { find: vi.fn(), findOne: vi.fn() };

  beforeEach(async () => {
    vi.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: getRepositoryToken(Project), useValue: projectRepo },
        { provide: getRepositoryToken(Member), useValue: memberRepo },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  const launch = { id: 'p1', name: 'Launch', archived: false, tasks: [{ id: 't1' }] };

  it('lists the projects you are a member of, each with your place in it, without relations', async () => {
    const joinedAt = new Date('2026-10-01T09:00:00Z');
    memberRepo.find.mockResolvedValue([
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
    expect(memberRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1' } }),
    );
  });

  it('findOne is a 404 for someone who is not a member', async () => {
    memberRepo.findOne.mockResolvedValue(null);
    await expect(service.findOne('p1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('archive and reopen set the flag and answer the project with your role', async () => {
    projectRepo.update.mockResolvedValue({ affected: 1 });
    memberRepo.findOne.mockResolvedValue({ role: 'owner', project: launch, addedBy: null });

    await expect(service.archive('p1', 'u1')).resolves.toMatchObject({ role: 'owner' });
    expect(projectRepo.update).toHaveBeenCalledWith({ id: 'p1' }, { archived: true });
    await service.reopen('p1', 'u1');
    expect(projectRepo.update).toHaveBeenLastCalledWith({ id: 'p1' }, { archived: false });
  });

  it('archive is a 404 for a project that does not exist', async () => {
    projectRepo.update.mockResolvedValue({ affected: 0 });
    await expect(service.archive('p1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
