import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TaskDto } from './dto/task.dto.js';
import { TaskService } from './task.service.js';

const PROJECT_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const GROUP_ID = '0b1f1d6e-3c1a-4e0a-9d8b-5a5f6f7c8d90';

/** What the add-task form sends: no progress, order, type, priority or parentId. */
const formBody = (extra: Partial<TaskDto> = {}) =>
  ({
    name: 'Design review',
    projectId: PROJECT_ID,
    startDate: '2026-10-07',
    endDate: '2026-10-09',
    color: '#2a78d6',
    ...extra,
  }) as TaskDto;

describe('TaskService.create', () => {
  const query = { select: vi.fn(), where: vi.fn(), getRawOne: vi.fn() };
  const repo = {
    create: vi.fn(),
    save: vi.fn(),
    createQueryBuilder: vi.fn(),
    findOneByOrFail: vi.fn(),
    manager: { exists: vi.fn() },
  };
  let service: TaskService;

  beforeEach(() => {
    vi.resetAllMocks();
    query.select.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.getRawOne.mockResolvedValue({ max: null });
    repo.createQueryBuilder.mockReturnValue(query);
    repo.create.mockImplementation((values: object) => values);
    repo.save.mockImplementation((task: object) => Promise.resolve({ id: 't1', ...task }));
    repo.manager.exists.mockResolvedValue(true);
    service = new TaskService(repo as never, {} as never);
  });

  it('gives a task from the form progress 0 and the first order, so the insert has every required column', async () => {
    await service.create(formBody());
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ progress: 0, order: 1 }));
  });

  it('puts a new task after the project’s last one', async () => {
    query.getRawOne.mockResolvedValue({ max: 4 });
    await service.create(formBody());
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ order: 5 }));
    expect(query.where).toHaveBeenCalledWith('task.projectId = :projectId', {
      projectId: PROJECT_ID,
    });
  });

  it('keeps a progress and order the caller chose, without asking for the next order', async () => {
    await service.create(formBody({ progress: 40, order: 7 }));
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ progress: 40, order: 7 }));
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('rejects an end date before the start date and saves nothing', async () => {
    await expect(
      service.create(
        formBody({ startDate: '2026-10-09' as never, endDate: '2026-10-07' as never }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('answers 404 for a project that does not exist, and saves nothing', async () => {
    repo.manager.exists.mockResolvedValue(false);
    await expect(service.create(formBody())).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('only allows a group as the parent', async () => {
    repo.findOneByOrFail.mockResolvedValue({ id: GROUP_ID, type: 'task', projectId: PROJECT_ID });
    await expect(service.create(formBody({ parentId: GROUP_ID }))).rejects.toThrow(
      'Parent must be a group',
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('accepts a parent group of the same project', async () => {
    repo.findOneByOrFail.mockResolvedValue({ id: GROUP_ID, type: 'group', projectId: PROJECT_ID });
    await service.create(formBody({ parentId: GROUP_ID }));
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ parentId: GROUP_ID }));
  });
});

describe('TaskService.update', () => {
  const repo = { findOneByOrFail: vi.fn(), save: vi.fn() };
  const scheduler = { applyDateEdit: vi.fn() };
  const stored = () => ({
    id: 't1',
    name: 'Old',
    color: '#2a78d6',
    priority: 'medium',
    startDate: '2026-10-07',
    endDate: '2026-10-09',
  });
  let service: TaskService;

  beforeEach(() => {
    vi.resetAllMocks();
    repo.save.mockImplementation((task: object) => Promise.resolve(task));
    repo.findOneByOrFail.mockResolvedValue(stored());
    scheduler.applyDateEdit.mockImplementation((task: object) => Promise.resolve(task));
    service = new TaskService(repo as never, scheduler as never);
  });

  it('changes only the fields that were sent', async () => {
    await expect(service.update('t1', { name: 'New', priority: 'high' })).resolves.toMatchObject({
      name: 'New',
      priority: 'high',
      color: '#2a78d6',
    });
  });

  it('rejects moving only the end date before the stored start date, and saves nothing', async () => {
    await expect(service.update('t1', { endDate: '2026-10-01' as never })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('hands new dates to the scheduler, which also moves the tasks that follow', async () => {
    await service.update('t1', {
      startDate: '2026-11-01' as never,
      endDate: '2026-11-03' as never,
    });
    expect(scheduler.applyDateEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', startDate: '2026-11-01', endDate: '2026-11-03' }),
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('saves directly, without scheduling, when the dates did not change', async () => {
    await service.update('t1', { name: 'New', startDate: '2026-10-07' as never });
    expect(scheduler.applyDateEdit).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalled();
  });

  it('passes on the not-found error for an unknown task', async () => {
    repo.findOneByOrFail.mockRejectedValue(new NotFoundException());
    await expect(service.update('nope', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
