import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TaskDto } from './dto/task.dto.js';
import { Task } from './entities/task.entity.js';
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
  const scheduler = { saveAttached: vi.fn() };
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
    scheduler.saveAttached.mockImplementation((task: object) =>
      Promise.resolve({ id: 't1', ...task }),
    );
    service = new TaskService({ repo: () => repo } as never, scheduler as never);
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
    expect(scheduler.saveAttached).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: GROUP_ID }),
    );
  });

  it('saves a top-level task directly, and one in a group through the scheduler so the group stretches', async () => {
    await service.create(formBody());
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(scheduler.saveAttached).not.toHaveBeenCalled();
    repo.findOneByOrFail.mockResolvedValue({ id: GROUP_ID, type: 'group', projectId: PROJECT_ID });
    await service.create(formBody({ parentId: GROUP_ID }));
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(scheduler.saveAttached).toHaveBeenCalledTimes(1);
  });
});

describe('TaskService.setParent', () => {
  const repo = { findOneByOrFail: vi.fn(), save: vi.fn(), findOneBy: vi.fn() };
  const scheduler = { saveAttached: vi.fn() };
  let service: TaskService;

  beforeEach(() => {
    vi.resetAllMocks();
    repo.save.mockImplementation((task: object) => Promise.resolve(task));
    scheduler.saveAttached.mockImplementation((task: object) => Promise.resolve(task));
    service = new TaskService({ repo: () => repo } as never, scheduler as never);
  });

  it('puts the task under the group through the scheduler, which stretches the group', async () => {
    repo.findOneByOrFail
      .mockResolvedValueOnce({ id: 't1', projectId: PROJECT_ID, parentId: null })
      .mockResolvedValueOnce({ id: GROUP_ID, type: 'group', projectId: PROJECT_ID });
    await service.setParent('t1', GROUP_ID);
    expect(scheduler.saveAttached).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', parentId: GROUP_ID }),
      null,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('takes a task out of its group through the scheduler too, so the group shrinks', async () => {
    repo.findOneByOrFail.mockResolvedValueOnce({
      id: 't1',
      projectId: PROJECT_ID,
      parentId: GROUP_ID,
    });
    await service.setParent('t1', null);
    expect(scheduler.saveAttached).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', parentId: null }),
      GROUP_ID,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('saves a top-level task that stays top-level with a plain save', async () => {
    repo.findOneByOrFail.mockResolvedValueOnce({ id: 't1', projectId: PROJECT_ID, parentId: null });
    await service.setParent('t1', null);
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(scheduler.saveAttached).not.toHaveBeenCalled();
  });
});

describe('TaskService.setParent on groups that loop (old data)', () => {
  it('refuses a move under a group whose chain comes back to itself, instead of walking it forever', async () => {
    // p is inside q and q inside p; t is in neither, so the walk up from p never meets t.
    const rows: Record<string, object> = {
      t: { id: 't', projectId: PROJECT_ID, parentId: null, type: 'task' },
      p: { id: 'p', projectId: PROJECT_ID, parentId: 'q', type: 'group' },
      q: { id: 'q', projectId: PROJECT_ID, parentId: 'p', type: 'group' },
    };
    const repo = {
      findOneByOrFail: vi.fn(({ id }: { id: string }) => Promise.resolve(rows[id])),
      findOneBy: vi.fn(({ id }: { id: string }) => Promise.resolve(rows[id] ?? null)),
    };
    const scheduler = { saveAttached: vi.fn() };
    const service = new TaskService({ repo: () => repo } as never, scheduler as never);
    await expect(service.setParent('t', 'p')).rejects.toThrow(/groups loop into each other/);
    expect(scheduler.saveAttached).not.toHaveBeenCalled();
    expect(repo.findOneBy.mock.calls.length).toBeLessThan(5);
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
    service = new TaskService({ repo: () => repo } as never, scheduler as never);
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

  it('judges end before start by the day, not the instant', async () => {
    // Later in the same day, before it in time: the stored days are the same, so it is fine.
    await expect(
      service.update('t1', { endDate: '2026-10-07T01:00:00+14:00' as never }),
    ).resolves.toBeDefined();
    await expect(
      service.update('t1', { startDate: '2026-10-10T00:00:00Z' as never }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('gives a milestone no end of its own: it is its start', async () => {
    repo.findOneByOrFail.mockResolvedValue({ ...stored(), type: 'milestone' });
    const saved = await service.update('t1', { endDate: '2026-10-20' as never });
    expect(saved).toMatchObject({ startDate: '2026-10-07', endDate: '2026-10-07' });
  });

  it('refuses a null date with a 400 (it used to be a 500)', async () => {
    await expect(service.update('t1', { startDate: null as never })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('passes on the not-found error for an unknown task', async () => {
    repo.findOneByOrFail.mockRejectedValue(new NotFoundException());
    await expect(service.update('nope', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TaskService.remove', () => {
  const manager = { find: vi.fn(), delete: vi.fn(), update: vi.fn() };
  const repo = { findOneByOrFail: vi.fn(), manager: { transaction: vi.fn() } };
  const scheduler = { settle: vi.fn() };
  let service: TaskService;
  const row = (id: string, order: number) => ({ id, order });

  beforeEach(() => {
    vi.resetAllMocks();
    repo.manager.transaction.mockImplementation((work: (m: typeof manager) => unknown) =>
      work(manager),
    );
    service = new TaskService({ repo: () => repo } as never, scheduler as never);
  });

  it('fits the group the task was in to the tasks that are left, in the same transaction', async () => {
    repo.findOneByOrFail.mockResolvedValue({
      id: 't1',
      projectId: PROJECT_ID,
      parentId: GROUP_ID,
      order: 1,
    });
    manager.find.mockResolvedValueOnce([]);
    await service.remove('t1');
    expect(manager.delete).toHaveBeenCalled();
    expect(scheduler.settle).toHaveBeenCalledWith(manager, PROJECT_ID, [GROUP_ID], []);
  });

  it('has no group to fit for a top-level task', async () => {
    repo.findOneByOrFail.mockResolvedValue({
      id: 't1',
      projectId: PROJECT_ID,
      parentId: null,
      order: 1,
    });
    manager.find.mockResolvedValueOnce([]);
    await service.remove('t1');
    expect(scheduler.settle).not.toHaveBeenCalled();
  });

  it("a deleted group's tasks take its place at the top level (no clashing places)", async () => {
    // Top level: a1, G (2), b3. G holds c1, c2 (numbered 1, 2 inside it).
    repo.findOneByOrFail.mockResolvedValue({
      id: 'g',
      projectId: PROJECT_ID,
      parentId: null,
      order: 2,
    });
    manager.find
      .mockResolvedValueOnce([row('c1', 1), row('c2', 2)])
      .mockResolvedValueOnce([row('a', 1), row('c1', 1), row('c2', 2), row('b', 3)]);
    await service.remove('g');
    const placed = Object.fromEntries(
      manager.update.mock.calls.map((call) => {
        const [, where, set] = call as [unknown, { id: string }, { order: number }];
        return [where.id, set.order];
      }),
    );
    // a stays 1; c1, c2 where G was (2, 3); b after them (4).
    expect(placed).toEqual({ c1: 2, c2: 3, b: 4 });
  });

  it('a deleted group inside another: its tasks go into that group, at its place; it refits', async () => {
    // P holds p1 (1), G (2). G holds c1.
    repo.findOneByOrFail.mockResolvedValue({
      id: 'g',
      projectId: PROJECT_ID,
      parentId: 'p',
      order: 2,
    });
    manager.find
      .mockResolvedValueOnce([row('c1', 1)])
      .mockResolvedValueOnce([row('p1', 1), row('c1', 1)]);
    await service.remove('g');
    expect(manager.update).toHaveBeenCalledWith(Task, { parentId: 'g' }, { parentId: 'p' });
    // c1 after p1, where G was.
    expect(manager.update).toHaveBeenCalledWith(Task, { id: 'c1' }, { order: 2 });
    expect(scheduler.settle).toHaveBeenCalledWith(manager, PROJECT_ID, ['p'], []);
  });
});

describe('TaskService.move', () => {
  const manager = { update: vi.fn(), save: vi.fn() };
  const repo = {
    findOneByOrFail: vi.fn(),
    findOneBy: vi.fn(),
    find: vi.fn(),
    manager: { transaction: vi.fn() },
  };
  const scheduler = { saveAttached: vi.fn() };
  let service: TaskService;
  const row = (id: string, order: number, parentId: string | null = null) => ({
    id,
    order,
    parentId,
    projectId: PROJECT_ID,
    type: 'task',
  });

  beforeEach(() => {
    vi.resetAllMocks();
    repo.manager.transaction.mockImplementation((work: (m: typeof manager) => unknown) =>
      work(manager),
    );
    manager.save.mockImplementation((_entity: unknown, task: object) => Promise.resolve(task));
    scheduler.saveAttached.mockImplementation(
      async (task: object, _old: unknown, also?: (m: typeof manager) => Promise<void>) => {
        if (also) await also(manager);
        return task;
      },
    );
    service = new TaskService({ repo: () => repo } as never, scheduler as never);
  });

  it('puts a task at a new place in its level and numbers the level again', async () => {
    repo.findOneByOrFail.mockResolvedValue(row('c', 3));
    repo.find.mockResolvedValue([row('a', 1), row('b', 2), row('c', 3)]);
    const saved = await service.move('c', null, 0);
    expect(saved).toMatchObject({ id: 'c', order: 1, parentId: null });
    expect(manager.update).toHaveBeenCalledWith(expect.anything(), { id: 'a' }, { order: 2 });
    expect(manager.update).toHaveBeenCalledWith(expect.anything(), { id: 'b' }, { order: 3 });
    expect(scheduler.saveAttached).not.toHaveBeenCalled();
  });

  it('puts an index past the end at the end, and leaves tasks already in place alone', async () => {
    repo.findOneByOrFail.mockResolvedValue(row('a', 1));
    repo.find.mockResolvedValue([row('a', 1), row('b', 2), row('c', 3)]);
    const saved = await service.move('a', null, 99);
    expect(saved).toMatchObject({ id: 'a', order: 3 });
    expect(manager.update).toHaveBeenCalledWith(expect.anything(), { id: 'b' }, { order: 1 });
    expect(manager.update).toHaveBeenCalledWith(expect.anything(), { id: 'c' }, { order: 2 });
  });

  it('moves into a group through the scheduler (the groups refit), with the new order in the same transaction', async () => {
    repo.findOneByOrFail
      .mockResolvedValueOnce(row('t', 5))
      .mockResolvedValueOnce({ id: GROUP_ID, type: 'group', projectId: PROJECT_ID });
    repo.find.mockResolvedValue([row('k', 1, GROUP_ID)]);
    const saved = await service.move('t', GROUP_ID, 1);
    expect(saved).toMatchObject({ id: 't', parentId: GROUP_ID, order: 2 });
    expect(scheduler.saveAttached).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't', parentId: GROUP_ID }),
      null,
      expect.any(Function),
    );
  });

  it('refuses a milestone as the parent', async () => {
    repo.findOneByOrFail
      .mockResolvedValueOnce(row('t', 5))
      .mockResolvedValueOnce({ id: GROUP_ID, type: 'milestone', projectId: PROJECT_ID });
    await expect(service.move('t', GROUP_ID, 0)).rejects.toThrow('A milestone cannot hold tasks');
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('turns a plain task it is dropped onto into a group, in the same transaction', async () => {
    repo.findOneByOrFail
      .mockResolvedValueOnce(row('t', 5))
      .mockResolvedValueOnce({ id: GROUP_ID, type: 'task', projectId: PROJECT_ID });
    repo.find.mockResolvedValue([]);
    const saved = await service.move('t', GROUP_ID, 0);
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: GROUP_ID },
      { type: 'group' },
    );
    expect(saved).toMatchObject({ id: 't', parentId: GROUP_ID, order: 1 });
  });
});
