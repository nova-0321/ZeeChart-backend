import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { AuthGuard } from '../auth/auth.guard.js';
import { ProjectAccessGuard } from './project-access.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

describe('ProjectsController', () => {
  let controller: ProjectsController;
  const service = {
    update: vi.fn(),
    create: vi.fn(),
    findAll: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      // The controller only delegates; the service has its own spec.
      providers: [{ provide: ProjectsService, useValue: service }],
    })
      // Sign-in, membership and roles are tested end to end (test/ownership.e2e-spec.ts,
      // test/members.e2e-spec.ts).
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ProjectAccessGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ProjectsController>(ProjectsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('archiving and reopening go through PATCH, as any other change of the project (#57)', async () => {
    service.update.mockResolvedValue({ id: 'p1', archived: true });

    await expect(controller.update('p1', { archived: true }, 'user-1')).resolves.toMatchObject({
      archived: true,
    });
    expect(service.update).toHaveBeenCalledWith('p1', { archived: true }, 'user-1');
    // There is no other way to: the old /archive and /reopen routes are gone.
    expect('archive' in controller).toBe(false);
    expect('reopen' in controller).toBe(false);
  });

  it('a new project belongs to whoever creates it, and the list is theirs only', async () => {
    service.create.mockResolvedValue({ id: 'p1' });
    service.findAll.mockResolvedValue([]);
    await controller.create({ name: 'Launch' }, 'user-1');
    await controller.findAll('user-1');
    expect(service.create).toHaveBeenCalledWith({ name: 'Launch' }, 'user-1');
    expect(service.findAll).toHaveBeenCalledWith('user-1');
  });
});
