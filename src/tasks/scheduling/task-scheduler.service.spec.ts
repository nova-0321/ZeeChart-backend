import { BadRequestException } from '@nestjs/common';
import { Task } from '../entities/task.entity.js';
import type * as Schedule from './schedule.js';
import { planEdit, planReschedule } from './schedule.js';
import { TaskScheduler } from './task-scheduler.service.js';

// The real planner runs; spied on only so a test can make it fail in a way it never should.
vi.mock('./schedule.js', async (importOriginal) => {
  const real = await importOriginal<typeof Schedule>();
  return {
    ...real,
    planEdit: vi.fn(real.planEdit),
    planReschedule: vi.fn(real.planReschedule),
  };
});

const PROJECT_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

/** A task row as the database returns it (a `date` column comes back as "YYYY-MM-DD"). */
const row = (
  id: string,
  startDate: string,
  endDate: string,
  extra: { parentId?: string | null; type?: string } = {},
) =>
  ({
    id,
    name: id,
    projectId: PROJECT_ID,
    parentId: null,
    type: 'task',
    startDate,
    endDate,
    ...extra,
  }) as unknown as Task;

const link = (id: string, fromTaskId: string, toTaskId: string, type = 'FS', lagDays = 0) => ({
  id,
  fromTaskId,
  toTaskId,
  type,
  lagDays,
});

/** A lag long enough to push a task past the last year the app keeps: the planner refuses it. */
const TOO_FAR = 3_000_000;

/** The dates written to other rows, by id. */
const written = (update: { mock: { calls: unknown[][] } }) =>
  Object.fromEntries(
    update.mock.calls.map((call) => [(call[1] as { id: string }).id, call[2]]),
  ) as Record<string, { startDate: string; endDate: string }>;

describe('TaskScheduler', () => {
  /** The manager inside the transaction: every read and write of a step must go through it. */
  const trx = { find: vi.fn(), query: vi.fn(), save: vi.fn(), update: vi.fn() };
  /** The manager outside a transaction (the repo's). */
  const outer = {
    find: vi.fn(),
    query: vi.fn(),
    save: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };
  const repo = { manager: outer };
  let scheduler: TaskScheduler;

  /** What the database holds: rows found by `find`, links returned by the links query. */
  const stored = (tasks: Task[], links: ReturnType<typeof link>[] = []) => {
    for (const manager of [trx, outer]) {
      manager.find.mockResolvedValue(tasks);
      manager.query.mockResolvedValue(links);
    }
  };

  beforeEach(() => {
    vi.resetAllMocks();
    outer.transaction.mockImplementation((work: (m: typeof trx) => unknown) => work(trx));
    trx.save.mockImplementation((_entity: unknown, task: object) => Promise.resolve(task));
    trx.update.mockResolvedValue(undefined);
    scheduler = new TaskScheduler({ repo: () => repo } as never);
  });

  /** Group G (Oct 5-7) holds A; A finish-to-start B; C is on its own. */
  const project = () => {
    stored(
      [
        row('G', '2026-10-05', '2026-10-07', { type: 'group' }),
        row('A', '2026-10-05', '2026-10-07', { parentId: 'G' }),
        row('B', '2026-10-08', '2026-10-09'),
        row('C', '2026-10-01', '2026-10-02'),
      ],
      [link('l1', 'A', 'B')],
    );
  };

  describe('applyDateEdit', () => {
    it('saves the edited task and writes only the rows the move changed: the group and the follower', async () => {
      project();
      const task = row('A', '2026-10-06', '2026-10-08', { parentId: 'G' });

      const saved = await scheduler.applyDateEdit(task);

      expect(saved).toBe(task);
      expect(trx.save).toHaveBeenCalledWith(Task, task);
      expect(written(trx.update)).toEqual({
        G: { startDate: '2026-10-06', endDate: '2026-10-08' },
        B: { startDate: '2026-10-09', endDate: '2026-10-10' },
      });
      // The edited task is saved whole, not also updated; C did not move.
      expect(trx.update).toHaveBeenCalledTimes(2);
    });

    it('reads and writes in one transaction, never through the outer manager', async () => {
      project();
      await scheduler.applyDateEdit(row('A', '2026-10-06', '2026-10-08', { parentId: 'G' }));
      expect(outer.transaction).toHaveBeenCalledTimes(1);
      expect(trx.find).toHaveBeenCalledWith(Task, { where: { projectId: PROJECT_ID } });
      expect(trx.query).toHaveBeenCalledWith(expect.any(String), [PROJECT_ID]);
      for (const call of [outer.find, outer.query, outer.save, outer.update]) {
        expect(call).not.toHaveBeenCalled();
      }
    });

    it('saves the dates the planner settled on when the ones asked for break a link', async () => {
      project();
      // B moved before A ends: it stops at the first day the link allows.
      const task = row('B', '2026-10-06', '2026-10-07');

      const saved = await scheduler.applyDateEdit(task);

      expect(saved).toMatchObject({ startDate: '2026-10-08', endDate: '2026-10-09' });
      expect(trx.update).not.toHaveBeenCalled();
    });

    it('plans by day when the edit carries a time, and writes days', async () => {
      project();
      const task = row('A', '2026-10-06T00:00:00.000Z', '2026-10-08T00:00:00.000Z', {
        parentId: 'G',
      });
      await scheduler.applyDateEdit(task);
      expect(task).toMatchObject({ startDate: '2026-10-06', endDate: '2026-10-08' });
      expect(written(trx.update).B).toEqual({ startDate: '2026-10-09', endDate: '2026-10-10' });
    });

    it('turns a refused edit into a 400 with the reason, and saves nothing', async () => {
      project();
      const edit = scheduler.applyDateEdit(row('A', '2026-10-08', '2026-10-06'));
      await expect(edit).rejects.toBeInstanceOf(BadRequestException);
      await expect(edit).rejects.toThrow('The end date must not be before the start date');
      expect(trx.save).not.toHaveBeenCalled();
      expect(trx.update).not.toHaveBeenCalled();
    });

    it('lets other errors through as they are', async () => {
      // Only a ScheduleError is the user's mistake; a bug in the planner stays a 500.
      project();
      const bug = new TypeError('planner bug');
      vi.mocked(planEdit).mockImplementationOnce(() => {
        throw bug;
      });
      await expect(scheduler.applyDateEdit(row('A', '2026-10-05', '2026-10-07'))).rejects.toBe(bug);
      expect(trx.save).not.toHaveBeenCalled();
    });
  });

  describe('saveAttached', () => {
    /** T (Oct 20-21) was just put in G; the stored rows already have it there. */
    const attached = (links: ReturnType<typeof link>[] = []) => {
      const task = row('T', '2026-10-20', '2026-10-21', { parentId: 'G' });
      stored(
        [
          row('G', '2026-10-05', '2026-10-07', { type: 'group' }),
          row('A', '2026-10-05', '2026-10-07', { parentId: 'G' }),
          task,
          row('C', '2026-10-01', '2026-10-02'),
        ],
        links,
      );
      return task;
    };

    it('runs `also` first, then saves the task, in the same transaction', async () => {
      const task = attached();
      const order: string[] = [];
      const also = vi.fn(async (manager: unknown) => {
        expect(manager).toBe(trx);
        order.push('also');
      });
      trx.save.mockImplementation((_entity: unknown, saved: object) => {
        order.push('save');
        return Promise.resolve(saved);
      });

      await expect(scheduler.saveAttached(task, null, also)).resolves.toBe(task);

      expect(order).toEqual(['also', 'save']);
      expect(outer.transaction).toHaveBeenCalledTimes(1);
    });

    it('stretches the group to cover the task and pushes what follows the group', async () => {
      const task = attached([link('l1', 'G', 'C', 'FS')]);
      // C has to wait for G; it starts before G already, so it is pushed with G's new end.
      await scheduler.saveAttached(task);
      expect(written(trx.update)).toEqual({
        G: { startDate: '2026-10-05', endDate: '2026-10-21' },
        C: { startDate: '2026-10-22', endDate: '2026-10-23' },
      });
    });

    it('fits the group the task left to the tasks still in it', async () => {
      const task = row('T', '2026-10-20', '2026-10-21', { parentId: 'G' });
      stored([
        row('G', '2026-10-05', '2026-10-07', { type: 'group' }),
        row('A', '2026-10-05', '2026-10-07', { parentId: 'G' }),
        row('H', '2026-10-01', '2026-10-21', { type: 'group' }),
        row('K', '2026-10-01', '2026-10-03', { parentId: 'H' }),
        task,
      ]);
      await scheduler.saveAttached(task, 'H');
      expect(written(trx.update)).toEqual({
        G: { startDate: '2026-10-05', endDate: '2026-10-21' },
        H: { startDate: '2026-10-01', endDate: '2026-10-03' },
      });
    });

    it('turns a refusal of the planner into a 400 with its message', async () => {
      // A link between the task and the group it goes in can never be kept.
      const task = attached([link('l1', 'T', 'G')]);
      const attach = scheduler.saveAttached(task);
      await expect(attach).rejects.toBeInstanceOf(BadRequestException);
      await expect(attach).rejects.toThrow(`Can't put this task there: it is linked to "G"`);
      expect(trx.update).not.toHaveBeenCalled();
    });

    it('lets other errors through as they are', async () => {
      const task = attached();
      // A write that fails while the groups are fitted stays a 500 (and undoes the transaction).
      const down = new Error('connection lost');
      trx.update.mockRejectedValue(down);
      await expect(scheduler.saveAttached(task)).rejects.toBe(down);
    });
  });

  describe('refitGroup', () => {
    it('fits the group and the groups above it to the tasks left in them', async () => {
      stored([
        row('P', '2026-10-01', '2026-10-31', { type: 'group' }),
        row('G', '2026-10-01', '2026-10-31', { type: 'group', parentId: 'P' }),
        row('A', '2026-10-05', '2026-10-07', { parentId: 'G' }),
      ]);
      await scheduler.refitGroup(PROJECT_ID, 'G');
      expect(outer.transaction).toHaveBeenCalledTimes(1);
      expect(written(trx.update)).toEqual({
        G: { startDate: '2026-10-05', endDate: '2026-10-07' },
        P: { startDate: '2026-10-05', endDate: '2026-10-07' },
      });
    });

    it('turns a refusal of the planner into a 400', async () => {
      // The shrunk group now has to wait for X so long it would leave the years the app keeps.
      stored(
        [
          row('X', '2026-10-01', '2026-10-02'),
          row('G', '2026-10-01', '2026-10-31', { type: 'group' }),
          row('A', '2026-10-05', '2026-10-07', { parentId: 'G' }),
        ],
        [link('l1', 'X', 'G', 'FS', TOO_FAR)],
      );
      const refit = scheduler.refitGroup(PROJECT_ID, 'G');
      await expect(refit).rejects.toBeInstanceOf(BadRequestException);
      await expect(refit).rejects.toThrow("Can't use these dates");
      expect(trx.update).not.toHaveBeenCalled();
    });

    it('lets other errors through as they are', async () => {
      stored([
        row('G', '2026-10-01', '2026-10-31', { type: 'group' }),
        row('A', '2026-10-05', '2026-10-07', { parentId: 'G' }),
      ]);
      const down = new Error('connection lost');
      trx.update.mockRejectedValue(down);
      await expect(scheduler.refitGroup(PROJECT_ID, 'G')).rejects.toBe(down);
    });
  });

  describe('assertSchedulable', () => {
    beforeEach(() =>
      stored(
        [row('A', '2026-10-05', '2026-10-07'), row('B', '2026-10-08', '2026-10-09')],
        [link('l1', 'A', 'B')],
      ),
    );

    it('refuses a link that closes a loop with a 400 saying why', async () => {
      const check = scheduler.assertSchedulable(PROJECT_ID, link('', 'B', 'A') as never);
      await expect(check).rejects.toBeInstanceOf(BadRequestException);
      await expect(check).rejects.toThrow(
        'That link is impossible to schedule. These links cannot all be kept',
      );
    });

    it('passes a link the schedule can hold, and writes nothing even if it would push a task', async () => {
      await expect(
        scheduler.assertSchedulable(PROJECT_ID, {
          fromTaskId: 'B',
          toTaskId: 'A',
          type: 'SS',
          lagDays: -10,
        }),
      ).resolves.toBeUndefined();
      await expect(
        scheduler.assertSchedulable(PROJECT_ID, {
          fromTaskId: 'A',
          toTaskId: 'B',
          type: 'FS',
          lagDays: 5,
        }),
      ).resolves.toBeUndefined();
      // Only a check: it reads outside a transaction and stores nothing.
      expect(outer.transaction).not.toHaveBeenCalled();
      expect(outer.update).not.toHaveBeenCalled();
      expect(trx.update).not.toHaveBeenCalled();
    });

    it('checks a changed link in place of its stored version, not beside it', async () => {
      // Turning l1 round is fine; next to the old l1 it would be a loop.
      await expect(
        scheduler.assertSchedulable(PROJECT_ID, link('l1', 'B', 'A')),
      ).resolves.toBeUndefined();
      await expect(
        scheduler.assertSchedulable(PROJECT_ID, link('l2', 'B', 'A')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets other errors through as they are', async () => {
      const bug = new TypeError('planner bug');
      vi.mocked(planReschedule).mockImplementationOnce(() => {
        throw bug;
      });
      await expect(scheduler.assertSchedulable(PROJECT_ID, link('l2', 'A', 'B'))).rejects.toBe(bug);
    });
  });

  describe('rescheduleFrom', () => {
    it('pushes the followers of the task, and theirs, in one transaction', async () => {
      stored(
        [
          row('A', '2026-10-05', '2026-10-07'),
          row('B', '2026-10-06', '2026-10-07'),
          row('D', '2026-10-08', '2026-10-08'),
          row('C', '2026-10-01', '2026-10-02'),
        ],
        [link('l1', 'A', 'B'), link('l2', 'B', 'D')],
      );
      await scheduler.rescheduleFrom(PROJECT_ID, 'A');
      expect(outer.transaction).toHaveBeenCalledTimes(1);
      expect(written(trx.update)).toEqual({
        B: { startDate: '2026-10-08', endDate: '2026-10-09' },
        D: { startDate: '2026-10-10', endDate: '2026-10-10' },
      });
    });

    it('writes nothing when every link already holds', async () => {
      project();
      await scheduler.rescheduleFrom(PROJECT_ID, 'A');
      expect(trx.update).not.toHaveBeenCalled();
    });

    it('does not rewrite rows whose stored dates carry a time but are the same days', async () => {
      // Read by day: "2026-10-08T00:00:00.000Z" is the day B already starts on.
      stored(
        [
          row('A', '2026-10-05T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
          row('B', '2026-10-08T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
        ],
        [link('l1', 'A', 'B')],
      );
      await scheduler.rescheduleFrom(PROJECT_ID, 'A');
      expect(trx.update).not.toHaveBeenCalled();
    });
  });

  describe('settle', () => {
    /** The caller's transaction (an undo), separate from the repo's manager. */
    const caller = { find: vi.fn(), query: vi.fn(), update: vi.fn() };

    beforeEach(() => {
      caller.update.mockResolvedValue(undefined);
    });

    it("fits the given groups and pushes from the given tasks, with the caller's manager", async () => {
      caller.find.mockResolvedValue([
        row('G', '2026-10-01', '2026-10-31', { type: 'group' }),
        row('A', '2026-10-05', '2026-10-07', { parentId: 'G' }),
        row('W', '2026-10-10', '2026-10-12'),
        row('B', '2026-10-11', '2026-10-11'),
        row('C', '2026-10-01', '2026-10-02'),
      ]);
      caller.query.mockResolvedValue([link('l1', 'W', 'B')]);

      await scheduler.settle(caller as never, PROJECT_ID, ['G'], ['W']);

      expect(written(caller.update)).toEqual({
        G: { startDate: '2026-10-05', endDate: '2026-10-07' },
        B: { startDate: '2026-10-13', endDate: '2026-10-13' },
      });
      expect(caller.update).toHaveBeenCalledWith(Task, { id: 'B' }, expect.any(Object));
      // No transaction of its own: it is all or nothing with what the caller wrote.
      expect(outer.transaction).not.toHaveBeenCalled();
      expect(outer.find).not.toHaveBeenCalled();
      expect(trx.update).not.toHaveBeenCalled();
    });

    it('writes nothing when the groups fit and the links hold', async () => {
      caller.find.mockResolvedValue([
        row('G', '2026-10-05', '2026-10-07', { type: 'group' }),
        row('A', '2026-10-05', '2026-10-07', { parentId: 'G' }),
      ]);
      caller.query.mockResolvedValue([]);
      await scheduler.settle(caller as never, PROJECT_ID, ['G'], ['A']);
      expect(caller.update).not.toHaveBeenCalled();
    });

    it('turns a refusal of the planner into a 400', async () => {
      caller.find.mockResolvedValue([
        row('W', '2026-10-01', '2026-10-02'),
        row('B', '2026-10-03', '2026-10-04'),
      ]);
      caller.query.mockResolvedValue([link('l1', 'W', 'B', 'FS', TOO_FAR)]);
      await expect(scheduler.settle(caller as never, PROJECT_ID, [], ['W'])).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(caller.update).not.toHaveBeenCalled();
    });

    it('lets other errors through as they are', async () => {
      caller.find.mockResolvedValue([
        row('W', '2026-10-01', '2026-10-02'),
        row('B', '2026-10-01', '2026-10-02'),
      ]);
      caller.query.mockResolvedValue([link('l1', 'W', 'B')]);
      const down = new Error('connection lost');
      caller.update.mockRejectedValue(down);
      await expect(scheduler.settle(caller as never, PROJECT_ID, [], ['W'])).rejects.toBe(down);
    });
  });
});
