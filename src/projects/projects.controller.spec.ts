import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

describe('ProjectsController', () => {
  let controller: ProjectsController;
  const service = {
    archive: vi.fn(),
    reopen: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      // The controller only delegates; the service has its own spec.
      providers: [{ provide: ProjectsService, useValue: service }],
    }).compile();

    controller = module.get<ProjectsController>(ProjectsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('archive and reopen delegate to the service', async () => {
    service.archive.mockResolvedValue({ id: 'p1', archived: true });
    service.reopen.mockResolvedValue({ id: 'p1', archived: false });

    await expect(controller.archive('p1')).resolves.toMatchObject({ archived: true });
    await expect(controller.reopen('p1')).resolves.toMatchObject({ archived: false });
    expect(service.archive).toHaveBeenCalledWith('p1');
    expect(service.reopen).toHaveBeenCalledWith('p1');
  });
});
