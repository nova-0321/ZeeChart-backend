import { NotFoundException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Project } from './entities/project.entity.js';
import { ProjectsService } from './projects.service.js';

describe('ProjectsService', () => {
  let service: ProjectsService;
  const repo = {
    create: vi.fn(),
    save: vi.fn(),
    find: vi.fn(),
    findOneBy: vi.fn(),
    merge: vi.fn(),
    remove: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProjectsService, { provide: getRepositoryToken(Project), useValue: repo }],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('findOne throws NotFoundException when the project does not exist', async () => {
    repo.findOneBy.mockResolvedValue(null);
    await expect(service.findOne('missing-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('archive and reopen toggle the archived flag', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'p1', archived: false });
    repo.save.mockImplementation((project: Project) => Promise.resolve(project));

    await expect(service.archive('p1')).resolves.toMatchObject({ archived: true });
    await expect(service.reopen('p1')).resolves.toMatchObject({ archived: false });
  });
});
