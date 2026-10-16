import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Revision } from '../entities/revision.entity.js';
import type { ProjectState, Snapshot, TaskState } from '../history/revision-diff.js';
import { UndoService } from './undo.service.js';

// UndoService reads the batches and the project, asks undo-plan.ts what to do, and writes. The
// writes are each domain's own functions (stand-ins here), so a test sees exactly what was written,
// and that nothing was when the undo is refused.

const db = vi.hoisted(() => ({
  loadSnapshot: vi.fn(),
  roleIn: vi.fn(),
  ownersOwnProjectNamed: vi.fn(),
  writeTask: vi.fn(),
  setTaskParent: vi.fn(),
  parentIdOf: vi.fn(),
  taskTreeOf: vi.fn(),
  putAtPlace: vi.fn(),
  numberLevels: vi.fn(),
  writeLink: vi.fn(),
  writeEvent: vi.fn(),
  writeProjectRow: vi.fn(),
  remove: {
    task: vi.fn(),
    event: vi.fn(),
    link: vi.fn(),
    project: vi.fn(),
  },
}));
vi.mock('../revision-state.js', () => ({ loadSnapshot: db.loadSnapshot }));
vi.mock('../../members/membership.js', () => ({
  roleIn: db.roleIn,
  ownersOwnProjectNamed: db.ownersOwnProjectNamed,
}));
vi.mock('../../tasks/task-rows.js', () => ({
  writeTask: db.writeTask,
  setTaskParent: db.setTaskParent,
  parentIdOf: db.parentIdOf,
  taskTreeOf: db.taskTreeOf,
  putAtPlace: db.putAtPlace,
  numberLevels: db.numberLevels,
}));
vi.mock('../../dependencies/link-rows.js', () => ({ writeLink: db.writeLink }));
vi.mock('../../events/event-rows.js', () => ({ writeEvent: db.writeEvent }));
vi.mock('../../projects/project-rows.js', () => ({ writeProjectRow: db.writeProjectRow }));
vi.mock('../rows.js', () => ({
  ROWS: {
    task: { remove: db.remove.task },
    event: { remove: db.remove.event },
    link: { remove: db.remove.link },
    project: { remove: db.remove.project },
  },
}));

const PROJECT_ID = 'p1';
const USER_ID = 'u1';
const PROJECT: ProjectState = { id: PROJECT_ID, name: 'Plan', description: null, archived: false };

const task = (id: string, fields: Partial<TaskState> = {}): TaskState => ({
  id,
  name: id,
  description: null,
  type: 'task',
  priority: 'medium',
  startDate: '2026-11-02',
  endDate: '2026-11-06',
  progress: 0,
  color: '#2a78d6',
  order: 1,
  parentId: null,
  ...fields,
});

const snapshot = (tasks: TaskState[] = [], project: ProjectState | null = PROJECT): Snapshot => ({
  project,
  tasks: new Map(tasks.map((row) => [row.id, row])),
  events: new Map(),
  links: [],
});

const revision = (
  fields: Partial<Omit<Revision, 'before' | 'after'>> & {
    before?: object | null;
    after?: object | null;
  },
): Revision =>
  ({
    batchId: 'b1',
    projectId: PROJECT_ID,
    entityType: 'task',
    entityId: 't1',
    before: null,
    after: null,
    summary: 'Changed',
    primary: false,
    ...fields,
  }) as Revision;

describe('UndoService', () => {
  const txManager = { name: 'transaction' };
  const manager = { query: vi.fn(), transaction: vi.fn() };
  const revisionRepo = { find: vi.fn(), findOne: vi.fn() };
  const scheduler = { settle: vi.fn() };
  let service: UndoService;
  /** Each task's group as setTaskParent left it. */
  const parents = new Map<string, string | null>();

  /** The person's batches, oldest first, as the stacks query answers them. */
  const batches = (...rows: { batchId: string; batchKind?: string; ofBatch?: string }[]) =>
    manager.query.mockResolvedValue(
      rows.map((row) => ({ batchKind: 'change', ofBatch: null, creation: false, ...row })),
    );

  /** No write of any kind happened. */
  const expectNothingWritten = () => {
    expect(manager.transaction).not.toHaveBeenCalled();
    for (const write of [
      db.writeTask,
      db.writeEvent,
      db.writeLink,
      db.writeProjectRow,
      db.remove.task,
      db.numberLevels,
      scheduler.settle,
    ]) {
      expect(write).not.toHaveBeenCalled();
    }
  };

  beforeEach(() => {
    vi.resetAllMocks();
    manager.transaction.mockImplementation((work: (m: typeof txManager) => unknown) =>
      work(txManager),
    );
    db.roleIn.mockResolvedValue('owner');
    db.ownersOwnProjectNamed.mockResolvedValue(false);
    db.taskTreeOf.mockResolvedValue([]);
    // By default every task ends up in the group it was written to.
    db.setTaskParent.mockImplementation((_m: unknown, id: string, parentId: string | null) => {
      parents.set(id, parentId);
    });
    db.parentIdOf.mockImplementation((_m: unknown, id: string) => parents.get(id) ?? null);
    parents.clear();
    service = new UndoService({ repo: () => revisionRepo, manager } as never, scheduler as never);
  });

  describe('state', () => {
    it('answers the top of each stack with what it did, without the "Undo: " it was noted with', async () => {
      batches(
        { batchId: 'a' },
        { batchId: 'b' },
        { batchId: 'u1', batchKind: 'undo', ofBatch: 'b' },
      );
      revisionRepo.findOne.mockImplementation(({ where }: { where: { batchId: string } }) =>
        Promise.resolve({ summary: where.batchId === 'a' ? 'Redo: Added “A”' : 'Renamed “B”' }),
      );
      await expect(service.state(PROJECT_ID, USER_ID)).resolves.toEqual({
        undo: { batchId: 'a', summary: 'Added “A”' },
        redo: { batchId: 'b', summary: 'Renamed “B”' },
      });
      expect(manager.query).toHaveBeenCalledWith(expect.any(String), [
        PROJECT_ID,
        USER_ID,
        expect.any(Number),
      ]);
    });

    it('answers null for an empty stack', async () => {
      batches();
      await expect(service.state(PROJECT_ID, USER_ID)).resolves.toEqual({ undo: null, redo: null });
      expect(revisionRepo.findOne).not.toHaveBeenCalled();
    });

    it('answers null for a batch whose revisions are gone', async () => {
      batches({ batchId: 'a' });
      revisionRepo.findOne.mockResolvedValue(null);
      await expect(service.state(PROJECT_ID, USER_ID)).resolves.toEqual({ undo: null, redo: null });
    });
  });

  describe('undo and redo with nothing to do', () => {
    it('refuses an undo with an empty undo stack', async () => {
      batches();
      const done = service.undo(PROJECT_ID, USER_ID);
      await expect(done).rejects.toThrow(ConflictException);
      await expect(done).rejects.toThrow('Nothing to undo');
    });

    it('refuses a redo with an empty redo stack', async () => {
      batches({ batchId: 'a' });
      const done = service.redo(PROJECT_ID, USER_ID);
      await expect(done).rejects.toThrow(ConflictException);
      await expect(done).rejects.toThrow('Nothing to redo');
    });
  });

  describe('apply', () => {
    it('answers 404 for a batch with no revisions in the project', async () => {
      batches({ batchId: 'b1' });
      revisionRepo.find.mockResolvedValue([]);
      const done = service.undo(PROJECT_ID, USER_ID);
      await expect(done).rejects.toThrow(NotFoundException);
      await expect(done).rejects.toThrow('Change not found');
      expect(revisionRepo.find).toHaveBeenCalledWith({
        where: { batchId: 'b1', projectId: PROJECT_ID },
      });
    });

    it('refuses a change to the project itself to someone who is not an owner', async () => {
      batches({ batchId: 'b1' });
      revisionRepo.find.mockResolvedValue([
        revision({
          entityType: 'project',
          entityId: PROJECT_ID,
          before: { ...PROJECT, name: 'Old' },
          after: PROJECT,
        }),
      ]);
      db.roleIn.mockResolvedValue('editor');
      await expect(service.undo(PROJECT_ID, USER_ID)).rejects.toThrow(ForbiddenException);
      expect(db.roleIn).toHaveBeenCalledWith(manager, PROJECT_ID, USER_ID);
      expectNothingWritten();
    });

    it("doesn't ask the role for a batch that only touches tasks", async () => {
      batches({ batchId: 'b1' });
      revisionRepo.find.mockResolvedValue([
        revision({ before: task('t1'), after: task('t1', { progress: 50 }) }),
      ]);
      db.loadSnapshot.mockResolvedValue(snapshot([task('t1', { progress: 50 })]));
      await service.undo(PROJECT_ID, USER_ID);
      expect(db.roleIn).not.toHaveBeenCalled();
    });

    it('refuses (409) when a row changed since, and writes nothing', async () => {
      batches({ batchId: 'b1' });
      revisionRepo.find.mockResolvedValue([
        revision({ before: task('t1', { name: 'Old' }), after: task('t1', { name: 'Draft' }) }),
      ]);
      db.loadSnapshot.mockResolvedValue(snapshot([task('t1', { name: 'Final' })]));
      const done = service.undo(PROJECT_ID, USER_ID);
      await expect(done).rejects.toThrow(ConflictException);
      await expect(done).rejects.toThrow("Can't undo: “Final” was changed since");
      expectNothingWritten();
    });

    it('writes the whole undo in one transaction', async () => {
      // One batch: renamed the project, moved t1 into g1, made t2, added an event and a link.
      batches({ batchId: 'b1' });
      const event = { id: 'e1', name: 'Launch', color: '#000', startDate: 'x', endDate: 'x' };
      const link = { id: 'l1', fromTaskId: 't1', toTaskId: 't3', type: 'fs', lagDays: 0 };
      revisionRepo.find.mockResolvedValue([
        revision({
          entityType: 'project',
          entityId: PROJECT_ID,
          before: { ...PROJECT, name: 'Old plan' },
          after: PROJECT,
        }),
        revision({
          entityId: 't1',
          before: task('t1', { parentId: null }),
          after: task('t1', { parentId: 'g1' }),
          primary: true,
          summary: 'Moved “t1”',
        }),
        revision({ entityId: 't2', before: null, after: task('t2') }),
        revision({ entityType: 'event', entityId: 'e1', before: null, after: event }),
        revision({
          entityType: 'link',
          entityId: 'l1',
          before: { ...link, lagDays: 3 },
          after: link,
        }),
      ]);
      db.loadSnapshot.mockResolvedValue({
        ...snapshot([
          task('g1', { type: 'group' }),
          task('t1', { parentId: 'g1', order: 7 }),
          task('t2'),
        ]),
        events: new Map([['e1', event]]),
        links: [link],
      });

      const applied = await service.undo(PROJECT_ID, USER_ID);

      expect(manager.transaction).toHaveBeenCalledTimes(1);
      expect(db.ownersOwnProjectNamed).toHaveBeenCalledWith(txManager, PROJECT_ID, 'Old plan');
      expect(db.writeProjectRow).toHaveBeenCalledWith(txManager, {
        id: PROJECT_ID,
        name: 'Old plan',
        description: null,
        archived: false,
      });
      // What the batch made is removed (the event and t2); the project never is.
      expect(db.remove.task).toHaveBeenCalledWith(txManager, 't2');
      expect(db.remove.event).toHaveBeenCalledWith(txManager, 'e1');
      expect(db.remove.project).not.toHaveBeenCalled();
      // t1 back at the top level, keeping the order it has now (the batch didn't move it in its list).
      expect(db.writeTask).toHaveBeenCalledTimes(1);
      expect(db.writeTask).toHaveBeenCalledWith(
        txManager,
        PROJECT_ID,
        task('t1', { parentId: null, order: 7 }),
      );
      expect(db.setTaskParent).toHaveBeenCalledWith(txManager, 't1', null);
      expect(db.writeEvent).not.toHaveBeenCalled();
      expect(db.writeLink).toHaveBeenCalledWith(txManager, PROJECT_ID, { ...link, lagDays: 3 });
      expect(db.taskTreeOf).toHaveBeenCalledWith(txManager, PROJECT_ID);
      expect(db.putAtPlace).not.toHaveBeenCalled();
      expect(db.numberLevels).toHaveBeenCalledWith(
        txManager,
        PROJECT_ID,
        new Set(['g1', null]),
        new Set(['t1']),
      );
      expect(scheduler.settle).toHaveBeenCalledWith(txManager, PROJECT_ID, new Set(['g1']), ['t1']);
      expect(applied).toEqual({ step: { batchId: 'b1', summary: 'Moved “t1”' }, placed: [] });
    });

    it('writes back a removed task, its event and its links on a redo', async () => {
      // An undo removed t1 (with its link) and an event; the redo puts them back.
      batches({ batchId: 'b1' }, { batchId: 'u1', batchKind: 'undo', ofBatch: 'b1' });
      const event = { id: 'e1', name: 'Launch', color: '#000', startDate: 'x', endDate: 'x' };
      const link = { id: 'l1', fromTaskId: 't1', toTaskId: 't3', type: 'fs', lagDays: 0 };
      const made = task('t1', { parentId: 'g1', links: [link] });
      revisionRepo.find.mockResolvedValue([
        revision({ entityId: 't1', before: null, after: made, summary: 'Undo: Added “t1”' }),
        revision({ entityType: 'event', entityId: 'e1', before: null, after: event }),
      ]);
      db.loadSnapshot.mockResolvedValue(snapshot([task('g1', { type: 'group' })]));

      const applied = await service.redo(PROJECT_ID, USER_ID);

      // Not there now: written with the order it had.
      expect(db.writeTask).toHaveBeenCalledWith(txManager, PROJECT_ID, made);
      expect(db.setTaskParent).toHaveBeenCalledWith(txManager, 't1', 'g1');
      expect(db.writeEvent).toHaveBeenCalledWith(txManager, PROJECT_ID, event);
      expect(db.writeLink).toHaveBeenCalledWith(txManager, PROJECT_ID, link);
      expect(db.remove.task).not.toHaveBeenCalled();
      expect(db.numberLevels).toHaveBeenCalledWith(
        txManager,
        PROJECT_ID,
        new Set(['g1']),
        new Set(['t1']),
      );
      expect(scheduler.settle).toHaveBeenCalledWith(txManager, PROJECT_ID, new Set(['g1']), ['t1']);
      // No primary revision: the first one names the step.
      expect(applied).toEqual({ step: { batchId: 'b1', summary: 'Added “t1”' }, placed: [] });
    });

    it('puts a task the batch moved in its list back at its place, and answers it as placed', async () => {
      batches({ batchId: 'b1' });
      revisionRepo.find.mockResolvedValue([
        revision({
          entityId: 't1',
          before: task('t1', { order: 1, place: 0 }),
          after: task('t1', { order: 3, place: 2 }),
        }),
      ]);
      db.loadSnapshot.mockResolvedValue(snapshot([task('t1', { order: 4 })]));

      const applied = await service.undo(PROJECT_ID, USER_ID);

      // Its own order is written (not the 4 it has now), then it goes to its place.
      expect(db.writeTask).toHaveBeenCalledWith(
        txManager,
        PROJECT_ID,
        task('t1', { order: 1, place: 0 }),
      );
      expect(db.putAtPlace).toHaveBeenCalledWith(txManager, PROJECT_ID, 't1', null, 0);
      expect(applied.placed).toEqual(['t1']);
    });

    it('refuses (409) the project name back when an owner has another project with it now', async () => {
      batches({ batchId: 'b1' });
      revisionRepo.find.mockResolvedValue([
        revision({
          entityType: 'project',
          entityId: PROJECT_ID,
          before: { ...PROJECT, name: 'Old plan' },
          after: PROJECT,
        }),
      ]);
      db.loadSnapshot.mockResolvedValue(snapshot());
      db.ownersOwnProjectNamed.mockResolvedValue(true);
      const done = service.undo(PROJECT_ID, USER_ID);
      await expect(done).rejects.toThrow(ConflictException);
      await expect(done).rejects.toThrow(
        "Can't undo: an owner of this project has another one called “Old plan” now",
      );
      expect(db.writeProjectRow).not.toHaveBeenCalled();
      expect(scheduler.settle).not.toHaveBeenCalled();
    });

    it("doesn't check the name when the project keeps it", async () => {
      // The undo only unarchives it: the name is the one it has.
      batches({ batchId: 'b1' });
      revisionRepo.find.mockResolvedValue([
        revision({
          entityType: 'project',
          entityId: PROJECT_ID,
          before: PROJECT,
          after: { ...PROJECT, archived: true },
        }),
      ]);
      db.loadSnapshot.mockResolvedValue(snapshot([], { ...PROJECT, archived: true }));
      await service.undo(PROJECT_ID, USER_ID);
      expect(db.ownersOwnProjectNamed).not.toHaveBeenCalled();
      expect(db.writeProjectRow).toHaveBeenCalledWith(txManager, PROJECT);
    });

    it('refuses (409) when a task’s group is gone after writing', async () => {
      batches({ batchId: 'b1' });
      revisionRepo.find.mockResolvedValue([
        revision({
          entityId: 't1',
          before: task('t1', { name: 'Build', parentId: 'g1' }),
          after: task('t1', { name: 'Build' }),
        }),
      ]);
      db.loadSnapshot.mockResolvedValue(snapshot([task('t1', { name: 'Build' })]));
      // Someone deleted g1 since: setTaskParent leaves the task at the top level.
      db.setTaskParent.mockResolvedValue(undefined);
      db.parentIdOf.mockResolvedValue(null);
      const done = service.undo(PROJECT_ID, USER_ID);
      await expect(done).rejects.toThrow(ConflictException);
      await expect(done).rejects.toThrow("Can't undo: the group of “Build” is gone");
      expect(db.numberLevels).not.toHaveBeenCalled();
      expect(scheduler.settle).not.toHaveBeenCalled();
    });

    it('refuses (409) when the groups no longer form a tree after writing', async () => {
      batches({ batchId: 'b1' });
      revisionRepo.find.mockResolvedValue([
        revision({ entityId: 't1', before: task('t1'), after: task('t1', { progress: 50 }) }),
      ]);
      db.loadSnapshot.mockResolvedValue(snapshot([task('t1', { progress: 50 })]));
      db.taskTreeOf.mockResolvedValue([
        { id: 'g1', parentId: 'g2', type: 'group' },
        { id: 'g2', parentId: 'g1', type: 'group' },
      ]);
      await expect(service.undo(PROJECT_ID, USER_ID)).rejects.toThrow(
        "Can't undo: the groups were changed since",
      );
      expect(scheduler.settle).not.toHaveBeenCalled();
    });
  });
});
