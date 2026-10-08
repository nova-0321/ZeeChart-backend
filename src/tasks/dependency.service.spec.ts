import { BadRequestException } from '@nestjs/common';
import { DependencyService } from './dependency.service.js';

const PROJECT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const A = '0b1f1d6e-3c1a-4e0a-9d8b-5a5f6f7c8d90';
const B = '1c2f2e7f-4d2b-4f1b-8e9c-6b6a7a8d9ea1';

const task = (id: string, extra: object = {}) => ({
  id,
  projectId: PROJECT,
  type: 'task',
  ...extra,
});

describe('DependencyService.create', () => {
  const query = { select: vi.fn(), where: vi.fn(), getRawMany: vi.fn() };
  const dependencyRepo = {
    create: vi.fn(),
    save: vi.fn(),
    existsBy: vi.fn(),
    createQueryBuilder: vi.fn(),
  };
  const taskRepo = { findOneByOrFail: vi.fn(), findOneBy: vi.fn() };
  const scheduler = { rescheduleFrom: vi.fn(), assertSchedulable: vi.fn() };
  let service: DependencyService;

  beforeEach(() => {
    vi.resetAllMocks();
    query.select.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.getRawMany.mockResolvedValue([]);
    dependencyRepo.createQueryBuilder.mockReturnValue(query);
    dependencyRepo.existsBy.mockResolvedValue(false);
    dependencyRepo.create.mockImplementation((values: object) => values);
    dependencyRepo.save.mockImplementation((value: object) =>
      Promise.resolve({ id: 'd1', ...value }),
    );
    taskRepo.findOneByOrFail.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve(task(id)),
    );
    taskRepo.findOneBy.mockImplementation(({ id }: { id: string }) => Promise.resolve(task(id)));
    scheduler.rescheduleFrom.mockResolvedValue(undefined);
    scheduler.assertSchedulable.mockResolvedValue(undefined);
    service = new DependencyService(dependencyRepo as never, taskRepo as never, scheduler as never);
  });

  it('links two tasks of a project, finish to start unless told otherwise', async () => {
    await service.create({ fromTaskId: A, toTaskId: B });
    expect(dependencyRepo.save).toHaveBeenCalledWith({
      projectId: PROJECT,
      fromTaskId: A,
      toTaskId: B,
      type: 'FS',
      lagDays: 0,
    });
  });

  it('rejects a task linked to itself', async () => {
    await expect(service.create({ fromTaskId: A, toTaskId: A })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects tasks of different projects', async () => {
    taskRepo.findOneByOrFail.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve(task(id, id === B ? { projectId: 'other' } : {})),
    );
    await expect(service.create({ fromTaskId: A, toTaskId: B })).rejects.toThrow('same project');
  });

  it('links a group to a task outside it', async () => {
    taskRepo.findOneByOrFail.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve(task(id, id === A ? { type: 'group' } : {})),
    );
    await expect(service.create({ fromTaskId: A, toTaskId: B })).resolves.toBeDefined();
  });

  it('rejects a link between a group and a task inside it', async () => {
    taskRepo.findOneBy.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve(task(id, id === B ? { parentId: A } : {})),
    );
    await expect(service.create({ fromTaskId: A, toTaskId: B })).rejects.toThrow('inside it');
  });

  it('stores nothing when the schedule cannot hold the link', async () => {
    scheduler.assertSchedulable.mockRejectedValue(new BadRequestException('impossible'));
    await expect(service.create({ fromTaskId: A, toTaskId: B })).rejects.toThrow('impossible');
    expect(dependencyRepo.save).not.toHaveBeenCalled();
    expect(scheduler.rescheduleFrom).not.toHaveBeenCalled();
  });

  it('stores the lag and moves the successor if it is too early', async () => {
    await service.create({ fromTaskId: A, toTaskId: B, lagDays: 2 });
    expect(dependencyRepo.save).toHaveBeenCalledWith(expect.objectContaining({ lagDays: 2 }));
    expect(scheduler.rescheduleFrom).toHaveBeenCalledWith(PROJECT, A);
  });

  it('rejects a link that already exists', async () => {
    dependencyRepo.existsBy.mockResolvedValue(true);
    await expect(service.create({ fromTaskId: A, toTaskId: B })).rejects.toThrow('already linked');
  });

  it('rejects a link that closes a loop (B already leads back to A)', async () => {
    query.getRawMany.mockResolvedValue([{ id: A }]);
    await expect(service.create({ fromTaskId: A, toTaskId: B })).rejects.toThrow(
      'wait for each other',
    );
  });
});
