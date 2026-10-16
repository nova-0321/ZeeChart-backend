import { ConflictException, NotFoundException } from '@nestjs/common';
import type {
  EventState,
  LinkState,
  ProjectState,
  Snapshot,
  TaskState,
} from '../history/revision-diff.js';
import { ProjectVersion } from '../entities/project-version.entity.js';
import { KEEP_MANUAL_VERSIONS, MAX_STARRED_VERSIONS } from '../history-limits.js';
import { MAX_PAGE, PAGE_SIZE } from '../history/dto/page-query.dto.js';
import { contentOf, type VersionContent } from './version-content.js';
import { AUTO_EVERY_MS, KEEP_RECENT, VersionsService } from './versions.service.js';

// The row writers and readers of the other domains: what restore and copy write is checked through
// them (their SQL is tested end to end). version-content.ts is pure, so the real one is used.
const rows = vi.hoisted(() => ({
  loadSnapshot: vi.fn(),
  roleIn: vi.fn(),
  ownerIdsOf: vi.fn(),
  ownedNamesLike: vi.fn(),
  assertNameFree: vi.fn(),
  deleteLinksOf: vi.fn(),
  writeLink: vi.fn(),
  deleteEventsExcept: vi.fn(),
  writeEvent: vi.fn(),
  writeProjectFields: vi.fn(),
  deleteTasksExcept: vi.fn(),
  numberAllLevels: vi.fn(),
  setTaskParent: vi.fn(),
  writeTask: vi.fn(),
}));
vi.mock('../revision-state.js', () => ({ loadSnapshot: rows.loadSnapshot }));
vi.mock('../../members/membership.js', () => ({
  roleIn: rows.roleIn,
  ownerIdsOf: rows.ownerIdsOf,
  ownedNamesLike: rows.ownedNamesLike,
}));
// Only assertNameFree is used from it; ProjectsService itself is passed in as a fake.
vi.mock('../../projects/projects.service.js', () => ({
  assertNameFree: rows.assertNameFree,
  ProjectsService: class {},
}));
vi.mock('../../dependencies/link-rows.js', () => ({
  deleteLinksOf: rows.deleteLinksOf,
  writeLink: rows.writeLink,
}));
vi.mock('../../events/event-rows.js', () => ({
  deleteEventsExcept: rows.deleteEventsExcept,
  writeEvent: rows.writeEvent,
}));
vi.mock('../../projects/project-rows.js', () => ({
  writeProjectFields: rows.writeProjectFields,
}));
vi.mock('../../tasks/task-rows.js', () => ({
  deleteTasksExcept: rows.deleteTasksExcept,
  numberAllLevels: rows.numberAllLevels,
  setTaskParent: rows.setTaskParent,
  writeTask: rows.writeTask,
}));

const PROJECT_ID = 'p1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const project = (extra: Partial<ProjectState> = {}): ProjectState => ({
  id: PROJECT_ID,
  name: 'Launch',
  description: 'The plan',
  archived: false,
  ...extra,
});

const task = (id: string, parentId: string | null = null, order = 1): TaskState => ({
  id,
  name: `Task ${id}`,
  description: null,
  type: parentId ? 'task' : 'group',
  priority: 'medium',
  startDate: '2026-10-01',
  endDate: '2026-10-05',
  progress: 0,
  color: '#2a78d6',
  order,
  parentId,
});

const event = (id: string): EventState => ({
  id,
  name: `Event ${id}`,
  color: '#e00',
  startDate: '2026-10-02',
  endDate: '2026-10-02',
});

const link = (fromTaskId: string, toTaskId: string): LinkState => ({
  id: `l-${fromTaskId}-${toTaskId}`,
  fromTaskId,
  toTaskId,
  type: 'FS',
  lagDays: 0,
});

const snapshot = (
  tasks: TaskState[] = [],
  events: EventState[] = [],
  links: LinkState[] = [],
  of: ProjectState | null = project(),
): Snapshot => ({
  project: of,
  tasks: new Map(tasks.map((t) => [t.id, t])),
  events: new Map(events.map((e) => [e.id, e])),
  links,
});

const contentFrom = (snap: Snapshot): VersionContent =>
  contentOf({ ...snap, project: snap.project! });

/** A version row as the repository answers it. */
const versionRow = (number: number, content: VersionContent, extra: object = {}) => ({
  id: `v${number}`,
  projectId: PROJECT_ID,
  number,
  kind: 'auto',
  starred: false,
  createdAt: new Date('2026-10-10T09:00:00Z'),
  createdBy: null,
  content,
  ...extra,
});

describe('VersionsService', () => {
  const versionRepo = {
    createQueryBuilder: vi.fn(),
    findOne: vi.fn(),
    findOneBy: vi.fn(),
    countBy: vi.fn(),
    update: vi.fn(),
  };
  // A transaction (or savepoint) opened by the service: save() numbers and prunes in it, restore
  // and copy write the rows in it.
  const inner = { query: vi.fn(), save: vi.fn(), create: vi.fn(), update: vi.fn() };
  const manager = { query: vi.fn(), transaction: vi.fn() };
  const projects = { create: vi.fn() };
  /** The highest number in the project when save() asks for it. */
  let last: number | null;
  let service: VersionsService;

  /** The versions save() wrote, as passed to manager.save. */
  const saved = () => inner.save.mock.calls.map((call) => call[0] as Record<string, unknown>);
  const innerSql = () => inner.query.mock.calls.map((call) => String(call[0]));

  beforeEach(() => {
    vi.resetAllMocks();
    last = null;
    manager.transaction.mockImplementation((work: (m: typeof inner) => unknown) => work(inner));
    inner.query.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('MAX("number")') ? [{ last }] : []),
    );
    inner.create.mockImplementation((_entity: unknown, values: object) => ({ ...values }));
    inner.save.mockImplementation((row: { number: number }) =>
      Promise.resolve({ id: `v${row.number}`, ...row }),
    );
    rows.ownerIdsOf.mockResolvedValue([]);
    rows.ownedNamesLike.mockResolvedValue([]);
    service = new VersionsService(
      {
        repo: () => versionRepo,
        manager,
        run: (work: () => unknown) => work(),
      } as never,
      projects as never,
    );
  });

  describe('list', () => {
    const builder = {
      leftJoin: vi.fn(),
      select: vi.fn(),
      where: vi.fn(),
      andWhere: vi.fn(),
      orderBy: vi.fn(),
      limit: vi.fn(),
      getRawMany: vi.fn(),
    };

    beforeEach(() => {
      for (const step of ['leftJoin', 'select', 'where', 'andWhere', 'orderBy', 'limit'] as const) {
        builder[step].mockReturnValue(builder);
      }
      builder.getRawMany.mockResolvedValue([]);
      versionRepo.createQueryBuilder.mockReturnValue(builder);
    });

    it('lists the newest first, a page of PAGE_SIZE by default, with the counts as numbers', async () => {
      const createdAt = new Date('2026-10-10T09:00:00Z');
      builder.getRawMany.mockResolvedValue([
        {
          id: 'v2',
          number: 2,
          kind: 'manual',
          starred: true,
          createdAt,
          createdById: 'u1',
          createdByName: 'Olive',
          // jsonb_array_length comes back as a string from some drivers.
          tasks: '3',
          events: '1',
        },
        {
          id: 'v1',
          number: 1,
          kind: 'auto',
          starred: false,
          createdAt,
          createdById: null,
          createdByName: null,
          tasks: 0,
          events: 0,
        },
      ]);
      await expect(service.list(PROJECT_ID)).resolves.toEqual([
        {
          id: 'v2',
          number: 2,
          kind: 'manual',
          starred: true,
          createdAt,
          createdBy: { id: 'u1', name: 'Olive' },
          tasks: 3,
          events: 1,
        },
        {
          id: 'v1',
          number: 1,
          kind: 'auto',
          starred: false,
          createdAt,
          createdBy: null,
          tasks: 0,
          events: 0,
        },
      ]);
      expect(builder.where).toHaveBeenCalledWith('version.projectId = :projectId', {
        projectId: PROJECT_ID,
      });
      expect(builder.orderBy).toHaveBeenCalledWith('version.number', 'DESC');
      expect(builder.limit).toHaveBeenCalledWith(PAGE_SIZE);
      expect(builder.andWhere).not.toHaveBeenCalled();
    });

    it('gives an author whose name is gone an empty name, not null', async () => {
      builder.getRawMany.mockResolvedValue([
        { id: 'v1', number: 1, createdById: 'u1', createdByName: null, tasks: 0, events: 0 },
      ]);
      const [version] = await service.list(PROJECT_ID);
      expect(version.createdBy).toEqual({ id: 'u1', name: '' });
    });

    // An unknown `before` is no 404: the sub-select finds no number, so the page is just empty.
    it('goes on after `before` with the older ones (by number), in the same project', async () => {
      await service.list(PROJECT_ID, 'v7', 10);
      expect(builder.limit).toHaveBeenCalledWith(10);
      expect(builder.andWhere).toHaveBeenCalledWith(
        expect.stringMatching(/version\.number < \([\s\S]*cursor\."projectId" = :projectId/),
        { before: 'v7' },
      );
    });

    it('keeps the page size between 1 and MAX_PAGE', async () => {
      await service.list(PROJECT_ID, undefined, 0);
      expect(builder.limit).toHaveBeenLastCalledWith(1);
      await service.list(PROJECT_ID, undefined, MAX_PAGE + 50);
      expect(builder.limit).toHaveBeenLastCalledWith(MAX_PAGE);
    });
  });

  describe('get', () => {
    it('is a 404 "Version not found" for an unknown version', async () => {
      versionRepo.findOne.mockResolvedValue(null);
      await expect(service.get('nope')).rejects.toThrow(new NotFoundException('Version not found'));
    });

    it('answers the version with its content, its counts and who saved it', async () => {
      const content = contentFrom(snapshot([task('a'), task('b', 'a')], [event('e')]));
      versionRepo.findOne.mockResolvedValue(
        versionRow(3, content, { createdBy: { id: 'u1', name: 'Olive', email: 'o@x.io' } }),
      );
      await expect(service.get('v3')).resolves.toEqual(
        expect.objectContaining({
          id: 'v3',
          number: 3,
          tasks: 2,
          events: 1,
          createdBy: { id: 'u1', name: 'Olive' },
          content,
        }),
      );
      expect(versionRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'v3' },
        relations: { createdBy: true },
      });
    });
  });

  describe('star', () => {
    it('is a 404 for an unknown version, and writes nothing', async () => {
      versionRepo.findOneBy.mockResolvedValue(null);
      await expect(service.star('nope', true)).rejects.toThrow('Version not found');
      expect(versionRepo.update).not.toHaveBeenCalled();
    });

    it('stars a version and answers it', async () => {
      const content = contentFrom(snapshot());
      versionRepo.findOneBy.mockResolvedValue(versionRow(2, content));
      versionRepo.countBy.mockResolvedValue(MAX_STARRED_VERSIONS - 1);
      versionRepo.findOne.mockResolvedValue(versionRow(2, content, { starred: true }));
      await expect(service.star('v2', true)).resolves.toMatchObject({ id: 'v2', starred: true });
      expect(versionRepo.countBy).toHaveBeenCalledWith({ projectId: PROJECT_ID, starred: true });
      expect(versionRepo.update).toHaveBeenCalledWith({ id: 'v2' }, { starred: true });
    });

    it('refuses a star past MAX_STARRED_VERSIONS (a star keeps a version for good)', async () => {
      versionRepo.findOneBy.mockResolvedValue(versionRow(2, contentFrom(snapshot())));
      versionRepo.countBy.mockResolvedValue(MAX_STARRED_VERSIONS);
      await expect(service.star('v2', true)).rejects.toBeInstanceOf(ConflictException);
      expect(versionRepo.update).not.toHaveBeenCalled();
    });

    it('does not count again when starring one already starred, or unstarring', async () => {
      const content = contentFrom(snapshot());
      versionRepo.findOneBy.mockResolvedValue(versionRow(2, content, { starred: true }));
      versionRepo.findOne.mockResolvedValue(versionRow(2, content));
      await service.star('v2', true);
      await service.star('v2', false);
      expect(versionRepo.countBy).not.toHaveBeenCalled();
      expect(versionRepo.update).toHaveBeenLastCalledWith({ id: 'v2' }, { starred: false });
    });
  });

  describe('saveNow', () => {
    it('is a 404 "Project not found" when the project is gone', async () => {
      rows.loadSnapshot.mockResolvedValue(snapshot([], [], [], null));
      await expect(service.saveNow(PROJECT_ID, 'u1')).rejects.toThrow('Project not found');
      expect(inner.save).not.toHaveBeenCalled();
    });

    it('saves a manual version numbered after the last when the project differs from the newest', async () => {
      const now = snapshot([task('a')]);
      rows.loadSnapshot.mockResolvedValue(now);
      // The newest holds the project before task a.
      versionRepo.findOne
        .mockResolvedValueOnce(versionRow(4, contentFrom(snapshot())))
        .mockResolvedValueOnce(versionRow(5, contentFrom(now), { kind: 'manual' }));
      last = 4;
      const result = await service.saveNow(PROJECT_ID, 'u1');
      expect(result.created).toBe(true);
      expect(result.version).toMatchObject({ id: 'v5', number: 5, kind: 'manual' });
      expect(inner.create).toHaveBeenCalledWith(ProjectVersion, {
        projectId: PROJECT_ID,
        number: 5,
        kind: 'manual',
        content: contentFrom(now),
        createdById: 'u1',
      });
    });

    it('numbers the first version of a project 1', async () => {
      rows.loadSnapshot.mockResolvedValue(snapshot([task('a')]));
      versionRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(versionRow(1, contentFrom(snapshot([task('a')]))));
      await service.saveNow(PROJECT_ID, 'u1');
      expect(saved()).toEqual([expect.objectContaining({ number: 1 })]);
    });

    it('keeps the newest instead of a second copy when nothing changed, marked as saved by hand', async () => {
      const now = snapshot([task('a')], [event('e')]);
      rows.loadSnapshot.mockResolvedValue(now);
      versionRepo.findOne.mockResolvedValue(versionRow(4, contentFrom(now)));
      const result = await service.saveNow(PROJECT_ID, 'u1');
      expect(result).toMatchObject({ created: false, version: { id: 'v4' } });
      expect(versionRepo.update).toHaveBeenCalledWith({ id: 'v4' }, { kind: 'manual' });
      expect(inner.save).not.toHaveBeenCalled();
    });

    it('writes nothing when the unchanged newest is already a manual one', async () => {
      const now = snapshot([task('a')]);
      rows.loadSnapshot.mockResolvedValue(now);
      versionRepo.findOne.mockResolvedValue(versionRow(4, contentFrom(now), { kind: 'manual' }));
      await expect(service.saveNow(PROJECT_ID, 'u1')).resolves.toMatchObject({ created: false });
      expect(versionRepo.update).not.toHaveBeenCalled();
      expect(inner.save).not.toHaveBeenCalled();
    });

    it('takes the same rows in another order (as jsonb gives them back) as no change', async () => {
      const now = snapshot([task('b'), task('a')]);
      rows.loadSnapshot.mockResolvedValue(now);
      // Keys reordered, as a jsonb column reads back.
      const stored = JSON.parse(
        JSON.stringify(contentFrom(now), (_k, v: unknown) =>
          v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(Object.entries(v).reverse())
            : v,
        ),
      ) as VersionContent;
      versionRepo.findOne.mockResolvedValue(versionRow(4, stored, { kind: 'manual' }));
      await expect(service.saveNow(PROJECT_ID, 'u1')).resolves.toMatchObject({ created: false });
    });

    it('saves under a lock, then lets the oldest go: KEEP_RECENT others and KEEP_MANUAL_VERSIONS manual, never starred', async () => {
      rows.loadSnapshot.mockResolvedValue(snapshot([task('a')]));
      versionRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(versionRow(1, contentFrom(snapshot([task('a')]))));
      await service.saveNow(PROJECT_ID, 'u1');
      const sql = innerSql();
      expect(sql[0]).toContain('pg_advisory_xact_lock');
      expect(inner.query.mock.calls[0][1]).toEqual([`versions:${PROJECT_ID}`]);
      const prunes = inner.query.mock.calls.filter((call) => String(call[0]).includes('DELETE'));
      expect(prunes).toHaveLength(2);
      expect(String(prunes[0][0])).toMatch(/NOT "starred" AND "kind" <> 'manual'/);
      expect(prunes[0][1]).toEqual([PROJECT_ID, KEEP_RECENT]);
      expect(String(prunes[1][0])).toMatch(/NOT "starred" AND "kind" = 'manual'/);
      expect(prunes[1][1]).toEqual([PROJECT_ID, KEEP_MANUAL_VERSIONS]);
      // The new one is saved before the prune, so it counts among the kept.
      expect(inner.save.mock.invocationCallOrder[0]).toBeLessThan(
        inner.query.mock.invocationCallOrder[2],
      );
    });
  });

  describe('autoSave', () => {
    const after = snapshot([task('a')]);

    /** The newest version's number, whether it is due and its task count (the head query). */
    const head = (number: number, due: boolean, tasks = 1) =>
      manager.query.mockResolvedValue([{ number, due, tasks }]);

    it('does nothing for a project that is gone', async () => {
      await expect(service.autoSave(PROJECT_ID, snapshot([], [], [], null), 'u1')).resolves.toBe(
        false,
      );
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('asks the database whether the newest is older than AUTO_EVERY_MS', async () => {
      head(3, false);
      await service.autoSave(PROJECT_ID, after, 'u1');
      expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('make_interval'), [
        PROJECT_ID,
        AUTO_EVERY_MS / 1000,
      ]);
    });

    it('saves nothing while the newest version is younger than the interval', async () => {
      head(3, false);
      await expect(service.autoSave(PROJECT_ID, after, 'u1')).resolves.toBe(false);
      expect(versionRepo.findOne).not.toHaveBeenCalled();
      expect(inner.save).not.toHaveBeenCalled();
    });

    it('saves an auto version once the newest is older than the interval and differs', async () => {
      head(3, true);
      last = 3;
      versionRepo.findOne.mockResolvedValue(versionRow(3, contentFrom(snapshot())));
      await expect(service.autoSave(PROJECT_ID, after, 'u1')).resolves.toBe(true);
      expect(saved()).toEqual([
        expect.objectContaining({
          number: 4,
          kind: 'auto',
          content: contentFrom(after),
          createdById: 'u1',
        }),
      ]);
    });

    it('never saves the same content again, however old the newest is', async () => {
      head(3, true);
      versionRepo.findOne.mockResolvedValue(versionRow(3, contentFrom(after)));
      await expect(service.autoSave(PROJECT_ID, after, 'u1')).resolves.toBe(false);
      expect(inner.save).not.toHaveBeenCalled();
    });

    it('saves the first version of a project with no versions, without reading a newest', async () => {
      manager.query.mockResolvedValue([]);
      await expect(service.autoSave(PROJECT_ID, after, null)).resolves.toBe(true);
      expect(versionRepo.findOne).not.toHaveBeenCalled();
      expect(saved()).toEqual([expect.objectContaining({ number: 1, createdById: null })]);
    });

    // A new project's v1 is empty: its first change is kept at once, not 10 minutes later.
    it('saves at once after an empty v1, even when it is not due', async () => {
      head(1, false, 0);
      last = 1;
      versionRepo.findOne.mockResolvedValue(versionRow(1, contentFrom(snapshot())));
      await expect(service.autoSave(PROJECT_ID, after, 'u1')).resolves.toBe(true);
      expect(saved()).toEqual([expect.objectContaining({ number: 2 })]);
    });

    it('waits after a v1 that already has tasks (a copied project), like any version', async () => {
      head(1, false, 2);
      await expect(service.autoSave(PROJECT_ID, after, 'u1')).resolves.toBe(false);
      expect(inner.save).not.toHaveBeenCalled();
    });
  });

  describe('restore', () => {
    // The version: groups g (with child a) and task b, one event, a link a -> b; renamed project.
    const old = snapshot(
      [task('g', null, 1), task('a', 'g', 1), task('b', null, 2)],
      [event('e1')],
      [link('a', 'b')],
      project({ name: 'Launch v1', description: 'Old plan' }),
    );
    // Now: task c and event e2 were added, b was deleted.
    const now = snapshot(
      [task('g', null, 1), task('a', 'g', 1), task('c', null, 2)],
      [event('e1'), event('e2')],
    );

    beforeEach(() => {
      versionRepo.findOneBy.mockResolvedValue(versionRow(3, contentFrom(old)));
      rows.loadSnapshot.mockResolvedValue(now);
      versionRepo.findOne.mockResolvedValue(versionRow(6, contentFrom(snapshot())));
      rows.roleIn.mockResolvedValue('owner');
      rows.ownerIdsOf.mockResolvedValue(['u1']);
      last = 6;
    });

    it('is a 404 for an unknown version, and writes nothing', async () => {
      versionRepo.findOneBy.mockResolvedValue(null);
      await expect(service.restore('nope', 'u1')).rejects.toThrow('Version not found');
      expect(rows.writeTask).not.toHaveBeenCalled();
    });

    it('is a 404 when the version’s project is gone', async () => {
      rows.loadSnapshot.mockResolvedValue(snapshot([], [], [], null));
      await expect(service.restore('v3', 'u1')).rejects.toThrow('Project not found');
      expect(rows.writeTask).not.toHaveBeenCalled();
    });

    it('first saves the state it replaces as a before-restore version, and answers both numbers', async () => {
      await expect(service.restore('v3', 'u1')).resolves.toEqual({ version: 3, savedAs: 7 });
      expect(saved()).toEqual([
        expect.objectContaining({
          number: 7,
          kind: 'before-restore',
          content: contentFrom(now),
          createdById: 'u1',
        }),
      ]);
      // Saved before anything is written over.
      expect(inner.save.mock.invocationCallOrder[0]).toBeLessThan(
        rows.deleteLinksOf.mock.invocationCallOrder[0],
      );
    });

    it('saves no copy when the newest version already holds the current state (savedAs null)', async () => {
      versionRepo.findOne.mockResolvedValue(versionRow(6, contentFrom(now)));
      await expect(service.restore('v3', 'u1')).resolves.toEqual({ version: 3, savedAs: null });
      expect(inner.save).not.toHaveBeenCalled();
    });

    it('removes what the version doesn’t have, then writes its tasks, parents, levels, events and links', async () => {
      await service.restore('v3', 'u1');
      expect(rows.deleteLinksOf).toHaveBeenCalledWith(inner, PROJECT_ID);
      expect(rows.deleteTasksExcept).toHaveBeenCalledWith(inner, PROJECT_ID, ['a', 'b', 'g']);
      expect(rows.deleteEventsExcept).toHaveBeenCalledWith(inner, PROJECT_ID, ['e1']);
      expect(rows.writeTask.mock.calls.map((call) => call[2])).toEqual(contentFrom(old).tasks);
      expect(rows.writeTask).toHaveBeenCalledWith(inner, PROJECT_ID, expect.anything());
      expect(rows.setTaskParent.mock.calls).toEqual([[inner, 'a', 'g']]);
      expect(rows.numberAllLevels).toHaveBeenCalledWith(inner, PROJECT_ID);
      expect(rows.writeEvent).toHaveBeenCalledWith(inner, PROJECT_ID, event('e1'));
      expect(rows.writeLink).toHaveBeenCalledWith(inner, PROJECT_ID, link('a', 'b'));
      // Links go before the tasks they point at; parents only once every task is written; levels
      // numbered once the parents are back.
      const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
        fn.mock.invocationCallOrder;
      expect(order(rows.deleteLinksOf)[0]).toBeLessThan(order(rows.deleteTasksExcept)[0]);
      expect(Math.max(...order(rows.writeTask))).toBeLessThan(order(rows.setTaskParent)[0]);
      expect(order(rows.setTaskParent)[0]).toBeLessThan(order(rows.numberAllLevels)[0]);
      expect(Math.max(...order(rows.writeTask))).toBeLessThan(order(rows.writeLink)[0]);
    });

    it('lets go of the versions newer than the restored one, except starred, manual and the one just kept', async () => {
      await service.restore('v3', 'u1');
      const prune = inner.query.mock.calls.find((call) =>
        String(call[0]).includes('"number" > $2'),
      )!;
      expect(String(prune[0])).toMatch(/NOT "starred" AND "kind" <> 'manual'/);
      expect(prune[1]).toEqual([PROJECT_ID, 3, 'v7']);
    });

    it('keeps the newest out of the prune when it already held the current state', async () => {
      versionRepo.findOne.mockResolvedValue(versionRow(6, contentFrom(now)));
      await service.restore('v3', 'u1');
      const prune = inner.query.mock.calls.find((call) =>
        String(call[0]).includes('"number" > $2'),
      )!;
      expect(prune[1]).toEqual([PROJECT_ID, 3, 'v6']);
    });

    it('brings the name and description back for an owner when no owner has another project of that name', async () => {
      rows.ownerIdsOf.mockResolvedValue(['u1', 'u2']);
      await service.restore('v3', 'u1');
      expect(rows.assertNameFree).toHaveBeenCalledWith(inner, 'u1', 'Launch v1', PROJECT_ID);
      expect(rows.assertNameFree).toHaveBeenCalledWith(inner, 'u2', 'Launch v1', PROJECT_ID);
      expect(rows.writeProjectFields).toHaveBeenCalledWith(
        inner,
        PROJECT_ID,
        contentFrom(old).project,
        true,
      );
    });

    it('keeps the current name when an owner owns another project of that name (the rest still comes back)', async () => {
      rows.ownerIdsOf.mockResolvedValue(['u1', 'u2']);
      rows.assertNameFree.mockImplementation((_m: unknown, ownerId: string) =>
        ownerId === 'u2' ? Promise.reject(new ConflictException('taken')) : Promise.resolve(),
      );
      await expect(service.restore('v3', 'u1')).resolves.toEqual({ version: 3, savedAs: 7 });
      expect(rows.writeProjectFields).toHaveBeenCalledWith(
        inner,
        PROJECT_ID,
        contentFrom(old).project,
        false,
      );
    });

    it('leaves the project’s fields alone for an editor (an editor can’t rename it)', async () => {
      rows.roleIn.mockResolvedValue('editor');
      await service.restore('v3', 'u2');
      expect(rows.roleIn).toHaveBeenCalledWith(manager, PROJECT_ID, 'u2');
      expect(rows.writeProjectFields).not.toHaveBeenCalled();
      expect(rows.assertNameFree).not.toHaveBeenCalled();
      expect(rows.writeTask).toHaveBeenCalled();
    });
  });

  describe('copy', () => {
    // g holds a; b is top level; a -> b is a link; a's link to a task not in the version is dropped.
    const content = contentFrom(
      snapshot(
        [task('g', null, 1), task('a', 'g', 1), task('b', null, 2), task('x', 'gone', 3)],
        [event('e1'), event('e2')],
        [link('a', 'b'), link('a', 'outside')],
        project({ name: 'Launch', description: null }),
      ),
    );
    const made = snapshot([task('n1')]);

    beforeEach(() => {
      versionRepo.findOneBy.mockResolvedValue(versionRow(3, content));
      projects.create.mockResolvedValue({ id: 'p2', name: 'Launch (v3)', role: 'owner' });
      rows.loadSnapshot.mockResolvedValue(made);
    });

    /** The new id each original task got, from the writeTask calls (in content order). */
    const newIds = () =>
      Object.fromEntries(
        content.tasks.map((t, i) => [t.id, (rows.writeTask.mock.calls[i][2] as TaskState).id]),
      );

    it('is a 404 for an unknown version, and makes no project', async () => {
      versionRepo.findOneBy.mockResolvedValue(null);
      await expect(service.copy('nope', 'u1')).rejects.toThrow('Version not found');
      expect(projects.create).not.toHaveBeenCalled();
    });

    it('makes a project for the user named "<name> (vN)", and answers it', async () => {
      await expect(service.copy('v3', 'u1')).resolves.toEqual({
        id: 'p2',
        name: 'Launch (v3)',
        role: 'owner',
      });
      expect(rows.ownedNamesLike).toHaveBeenCalledWith(manager, 'u1', 'Launch (v3)');
      // No description: none is sent (not null).
      expect(projects.create).toHaveBeenCalledWith(
        { name: 'Launch (v3)', description: undefined },
        'u1',
      );
    });

    it('takes the first free name when the user owns one by that name already', async () => {
      rows.ownedNamesLike.mockResolvedValue(['Launch (v3)', 'Launch (v3) 2', 'Launch (v3) 4']);
      await service.copy('v3', 'u1');
      expect(projects.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Launch (v3) 3' }),
        'u1',
      );
    });

    it('cuts a long name so the suffix and a counter still fit in 255 characters', async () => {
      const long = contentFrom(snapshot([], [], [], project({ name: `${'x'.repeat(260)}` })));
      versionRepo.findOneBy.mockResolvedValue(versionRow(12, long));
      await service.copy('v12', 'u1');
      const { name } = projects.create.mock.calls[0][0] as { name: string };
      expect(name).toBe(`${'x'.repeat(255 - ' (v12)'.length - 4)} (v12)`);
      expect(`${name} 99`.length).toBeLessThanOrEqual(255);
    });

    it('keeps the description of the version', async () => {
      const described = contentFrom(snapshot([], [], [], project({ description: 'The plan' })));
      versionRepo.findOneBy.mockResolvedValue(versionRow(3, described));
      await service.copy('v3', 'u1');
      expect(projects.create).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'The plan' }),
        'u1',
      );
    });

    it('writes every task into the new project with a new id, the rest of it unchanged', async () => {
      await service.copy('v3', 'u1');
      expect(rows.writeTask).toHaveBeenCalledTimes(content.tasks.length);
      const ids = newIds();
      for (const [i, original] of content.tasks.entries()) {
        const [on, projectId, written] = rows.writeTask.mock.calls[i] as [
          unknown,
          string,
          TaskState,
        ];
        expect(on).toBe(inner);
        expect(projectId).toBe('p2');
        expect(written).toEqual({ ...original, id: ids[original.id] });
        expect(written.id).toMatch(UUID);
      }
      expect(new Set(Object.values(ids)).size).toBe(content.tasks.length);
    });

    it('puts each task under its parent’s new id, and leaves one whose parent isn’t copied at the top', async () => {
      await service.copy('v3', 'u1');
      const ids = newIds();
      expect(rows.setTaskParent.mock.calls).toEqual([[inner, ids.a, ids.g]]);
      expect(rows.numberAllLevels).toHaveBeenCalledWith(inner, 'p2');
      expect(rows.setTaskParent.mock.invocationCallOrder[0]).toBeLessThan(
        rows.numberAllLevels.mock.invocationCallOrder[0],
      );
    });

    it('copies the links between copied tasks only, as new links between the new ids', async () => {
      await service.copy('v3', 'u1');
      const ids = newIds();
      expect(rows.writeLink.mock.calls).toEqual([
        [inner, 'p2', { ...link('a', 'b'), id: undefined, fromTaskId: ids.a, toTaskId: ids.b }],
      ]);
    });

    it('copies every event with a new id', async () => {
      await service.copy('v3', 'u1');
      const written = rows.writeEvent.mock.calls.map((call) => call[2] as EventState);
      expect(
        rows.writeEvent.mock.calls.every((call) => call[0] === inner && call[1] === 'p2'),
      ).toBe(true);
      expect(written.map(({ id: _id, ...rest }) => rest)).toEqual(
        content.events.map(({ id: _id, ...rest }) => rest),
      );
      for (const e of written) {
        expect(e.id).toMatch(UUID);
        expect(['e1', 'e2']).not.toContain(e.id);
      }
    });

    it('makes the new project’s v1 what it was filled with, not the empty project', async () => {
      await service.copy('v3', 'u1');
      expect(rows.loadSnapshot).toHaveBeenCalledWith(inner, 'p2');
      expect(inner.update).toHaveBeenCalledWith(
        ProjectVersion,
        { projectId: 'p2', number: 1 },
        { content: contentFrom(made) },
      );
      // Read once everything is written.
      expect(rows.loadSnapshot.mock.invocationCallOrder[0]).toBeGreaterThan(
        Math.max(...rows.writeLink.mock.invocationCallOrder),
      );
    });

    it('leaves the version’s own project untouched', async () => {
      await service.copy('v3', 'u1');
      for (const fn of [rows.writeTask, rows.writeEvent, rows.writeLink, rows.numberAllLevels]) {
        expect(fn.mock.calls.every((call) => call[1] === 'p2')).toBe(true);
      }
      expect(rows.deleteTasksExcept).not.toHaveBeenCalled();
      expect(rows.deleteLinksOf).not.toHaveBeenCalled();
      expect(versionRepo.update).not.toHaveBeenCalled();
    });
  });
});
