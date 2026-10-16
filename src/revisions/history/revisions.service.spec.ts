import { Revision } from '../entities/revision.entity.js';
import { KEEP_REVISION_DAYS, UNDO_DEPTH } from '../history-limits.js';
import { ROWS } from '../rows.js';
import { MAX_PAGE, PAGE_SIZE } from './dto/page-query.dto.js';
import { diffSnapshots, type RevisionDraft, type Snapshot } from './revision-diff.js';
import { RevisionsService } from './revisions.service.js';

// What changed between the snapshots is revision-diff's (it has its own spec): here it is a fake,
// so each test says which rows changed.
vi.mock(import('./revision-diff.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  diffSnapshots: vi.fn(),
}));
// Each kind's domain sets its rows' versions (#55); the real ones write SQL.
vi.mock('../rows.js', () => {
  const rows = () => ({ setVersion: vi.fn() });
  return { ROWS: { project: rows(), task: rows(), event: rows(), link: rows() } };
});

const PROJECT_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const PROJECT = { id: PROJECT_ID, name: 'Plan', description: null, archived: false };

const snapshot = (project: Snapshot['project'] = PROJECT): Snapshot => ({
  project,
  tasks: new Map(),
  events: new Map(),
  links: [],
});

const draft = (entityId: string, extra: Partial<RevisionDraft> = {}): RevisionDraft => ({
  entityType: 'task',
  entityId,
  action: 'update',
  before: { id: entityId, name: 'Old' } as never,
  after: { id: entityId, name: 'New' } as never,
  summary: `Renamed ${entityId}`,
  ...extra,
});

describe('RevisionsService', () => {
  // The numbering's own transaction: the lock, the last versions, the save.
  const inner = {
    query: vi.fn(),
    create: vi.fn(),
    save: vi.fn(),
  };
  const manager = { transaction: vi.fn(), query: vi.fn() };
  const builder = {
    leftJoinAndSelect: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    addOrderBy: vi.fn(),
    limit: vi.fn(),
    andWhere: vi.fn(),
    getMany: vi.fn(),
  };
  const revisionRepo = { createQueryBuilder: vi.fn() };
  const tx = { repo: vi.fn(), manager };
  let service: RevisionsService;

  /** The revisions saved by the last record, as created. */
  const saved = () => inner.save.mock.calls[0][0] as Record<string, unknown>[];

  beforeEach(() => {
    vi.resetAllMocks();
    tx.repo.mockReturnValue(revisionRepo);
    manager.transaction.mockImplementation((work: (m: typeof inner) => unknown) => work(inner));
    inner.create.mockImplementation((_entity: unknown, values: object) => ({ ...values }));
    // The lock answers nothing; the last versions: none yet unless a test says so.
    inner.query.mockResolvedValue([]);
    revisionRepo.createQueryBuilder.mockReturnValue(builder);
    for (const step of ['leftJoinAndSelect', 'where', 'orderBy', 'addOrderBy', 'limit', 'andWhere'])
      builder[step as keyof typeof builder].mockReturnValue(builder);
    builder.getMany.mockResolvedValue([]);
    service = new RevisionsService(tx as never);
  });

  describe('record', () => {
    it('records nothing for a project that is gone: its history goes with it', async () => {
      const versions = await service.record(PROJECT_ID, snapshot(), snapshot(null), {
        userId: 'u1',
      });
      expect(versions.size).toBe(0);
      expect(diffSnapshots).not.toHaveBeenCalled();
      expect(manager.transaction).not.toHaveBeenCalled();
    });

    it('records nothing when no row changed', async () => {
      vi.mocked(diffSnapshots).mockReturnValue([]);
      const versions = await service.record(PROJECT_ID, snapshot(), snapshot(), { userId: 'u1' });
      expect(versions.size).toBe(0);
      expect(manager.transaction).not.toHaveBeenCalled();
    });

    it('hands the snapshots, the target and the placed tasks to the diff', async () => {
      vi.mocked(diffSnapshots).mockReturnValue([]);
      const before = snapshot();
      const after = snapshot();
      const placed = new Set(['t2']);
      await service.record(PROJECT_ID, before, after, { userId: 'u1', target: 't1', placed });
      expect(diffSnapshots).toHaveBeenCalledWith(before, after, 't1', placed);
    });

    it('numbers under a lock of the project, so two writes at once cannot take the same number', async () => {
      vi.mocked(diffSnapshots).mockReturnValue([draft('t1')]);
      await service.record(PROJECT_ID, snapshot(), snapshot(), { userId: 'u1' });
      expect(inner.query).toHaveBeenNthCalledWith(1, 'SELECT pg_advisory_xact_lock(hashtext($1))', [
        `revisions:${PROJECT_ID}`,
      ]);
      expect(inner.query).toHaveBeenNthCalledWith(2, expect.stringContaining('MAX("version")'), [
        ['t1'],
      ]);
    });

    it('numbers each row on from its last version, a new row from 1, and answers the new versions', async () => {
      vi.mocked(diffSnapshots).mockReturnValue([
        draft('t1'),
        draft('t2', { action: 'create', before: null }),
      ]);
      inner.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ entityId: 't1', version: 6 }]);
      const versions = await service.record(PROJECT_ID, snapshot(), snapshot(), { userId: 'u1' });
      expect(versions).toEqual(
        new Map([
          ['t1', 7],
          ['t2', 1],
        ]),
      );
      expect(saved().map((row) => row.version)).toEqual([7, 1]);
    });

    it('saves one revision per changed row, with its before and after, in one batch by the user', async () => {
      const primary = draft('t1', { primary: true });
      const pushed = draft('t2', { summary: 'Moved t2' });
      vi.mocked(diffSnapshots).mockReturnValue([primary, pushed]);
      await service.record(PROJECT_ID, snapshot(), snapshot(), { userId: 'u1' });
      expect(inner.create).toHaveBeenCalledWith(Revision, expect.anything());
      const [first, second] = saved();
      expect(first).toMatchObject({
        projectId: PROJECT_ID,
        entityType: 'task',
        entityId: 't1',
        action: 'update',
        changedById: 'u1',
        summary: 'Renamed t1',
        before: primary.before,
        after: primary.after,
        primary: true,
        batchKind: 'change',
        ofBatch: null,
      });
      // A row that changed because of the primary one is not primary.
      expect(second).toMatchObject({ entityId: 't2', summary: 'Moved t2', primary: false });
      expect(first.batchId).toEqual(expect.any(String));
      expect(second.batchId).toBe(first.batchId);
    });

    it('gives each write its own batch', async () => {
      vi.mocked(diffSnapshots).mockReturnValue([draft('t1')]);
      await service.record(PROJECT_ID, snapshot(), snapshot(), { userId: 'u1' });
      await service.record(PROJECT_ID, snapshot(), snapshot(), { userId: 'u1' });
      const [first, second] = inner.save.mock.calls.map(
        (call) => (call[0] as { batchId: string }[])[0].batchId,
      );
      expect(first).not.toBe(second);
    });

    it('records an undo or redo with its kind and the batch it undoes', async () => {
      vi.mocked(diffSnapshots).mockReturnValue([draft('t1')]);
      await service.record(PROJECT_ID, snapshot(), snapshot(), {
        userId: 'u1',
        batch: { kind: 'undo', of: 'b0' },
      });
      expect(saved()[0]).toMatchObject({ batchKind: 'undo', ofBatch: 'b0' });
    });

    it('records a change made by no one (a system write) with no author', async () => {
      vi.mocked(diffSnapshots).mockReturnValue([draft('t1')]);
      await service.record(PROJECT_ID, snapshot(), snapshot(), { userId: null });
      expect(saved()[0]).toMatchObject({ changedById: null });
    });

    it('puts a note before the summary of the target row only', async () => {
      vi.mocked(diffSnapshots).mockReturnValue([draft('t1'), draft('t2')]);
      await service.record(PROJECT_ID, snapshot(), snapshot(), {
        userId: 'u1',
        target: 't1',
        note: 'Restored version 3',
      });
      expect(saved().map((row) => row.summary)).toEqual([
        'Restored version 3: Renamed t1',
        'Renamed t2',
      ]);
    });

    it('puts a note before every summary when no row is the target', async () => {
      vi.mocked(diffSnapshots).mockReturnValue([draft('t1'), draft('t2')]);
      await service.record(PROJECT_ID, snapshot(), snapshot(), { userId: 'u1', note: 'Undo' });
      expect(saved().map((row) => row.summary)).toEqual(['Undo: Renamed t1', 'Undo: Renamed t2']);
    });

    it('sets the new version on each row that is still there, but not on a deleted one', async () => {
      vi.mocked(diffSnapshots).mockReturnValue([
        draft('t1'),
        draft('t2', { action: 'delete', after: null }),
        draft('e1', { entityType: 'event' }),
      ]);
      inner.query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ entityId: 't1', version: 2 }]);
      await service.record(PROJECT_ID, snapshot(), snapshot(), { userId: 'u1' });
      expect(ROWS.task.setVersion).toHaveBeenCalledTimes(1);
      expect(ROWS.task.setVersion).toHaveBeenCalledWith(inner, 't1', 3);
      expect(ROWS.event.setVersion).toHaveBeenCalledWith(inner, 'e1', 1);
      // The versions are set once the revisions are saved, in the same transaction.
      expect(inner.save.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(ROWS.task.setVersion).mock.invocationCallOrder[0],
      );
    });

    it('answers no versions when saving fails, the error going to the request', async () => {
      vi.mocked(diffSnapshots).mockReturnValue([draft('t1')]);
      inner.save.mockRejectedValue(new Error('db down'));
      await expect(
        service.record(PROJECT_ID, snapshot(), snapshot(), { userId: 'u1' }),
      ).rejects.toThrow('db down');
      expect(ROWS.task.setVersion).not.toHaveBeenCalled();
    });
  });

  describe('prune', () => {
    it('lets old revisions go by the history limits and answers how many went', async () => {
      manager.query.mockResolvedValue([[], 12]);
      await expect(service.prune(PROJECT_ID)).resolves.toBe(12);
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM "revisions"'),
        [PROJECT_ID, KEEP_REVISION_DAYS, UNDO_DEPTH],
      );
    });

    it('takes other limits when given', async () => {
      manager.query.mockResolvedValue([[], 0]);
      await expect(service.prune(PROJECT_ID, { days: 1, batches: 5 })).resolves.toBe(0);
      expect(manager.query).toHaveBeenCalledWith(expect.any(String), [PROJECT_ID, 1, 5]);
    });

    it('keeps the undo stacks, the batches they undo and the newest revision of a row still there', async () => {
      manager.query.mockResolvedValue([[], 0]);
      await service.prune(PROJECT_ID);
      const sql = manager.query.mock.calls[0][0] as string;
      expect(sql).toContain('PARTITION BY "changedById"');
      expect(sql).toContain('"ofBatch" IS NOT NULL');
      expect(sql).toContain(`r."action" = 'delete'`);
      expect(sql).toContain('n."version" > r."version"');
    });
  });

  describe('list', () => {
    it('lists the project’s history newest first, with who changed it', async () => {
      const createdAt = new Date('2026-10-10T09:00:00Z');
      builder.getMany.mockResolvedValue([
        {
          id: 'r2',
          entityType: 'task',
          entityId: 't1',
          version: 2,
          action: 'update',
          summary: 'Renamed “Design”',
          changedBy: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
          batchId: 'b2',
          primary: true,
          before: { name: 'A' },
          after: { name: 'B' },
          createdAt,
        },
        {
          id: 'r1',
          entityType: 'task',
          entityId: 't1',
          version: 1,
          action: 'create',
          summary: 'Added “Design”',
          changedBy: null,
          batchId: 'b1',
          primary: true,
          before: null,
          after: { name: 'A' },
          createdAt,
        },
      ]);
      const page = await service.list(PROJECT_ID);
      expect(builder.leftJoinAndSelect).toHaveBeenCalledWith('revision.changedBy', 'changedBy');
      expect(builder.where).toHaveBeenCalledWith('revision.projectId = :projectId', {
        projectId: PROJECT_ID,
      });
      expect(builder.orderBy).toHaveBeenCalledWith('revision.createdAt', 'DESC');
      // One request's revisions share their time: the id orders them.
      expect(builder.addOrderBy).toHaveBeenCalledWith('revision.id', 'DESC');
      expect(page.map((revision) => revision.id)).toEqual(['r2', 'r1']);
      // Only the author's id and name go out (not their email); an author since deleted is null.
      expect(page[0]).toMatchObject({
        summary: 'Renamed “Design”',
        changedBy: { id: 'u1', name: 'Ada' },
      });
      expect(page[0].changedBy).toEqual({ id: 'u1', name: 'Ada' });
      expect(page[1].changedBy).toBeNull();
    });

    it('answers a page of the default size', async () => {
      await service.list(PROJECT_ID);
      expect(builder.limit).toHaveBeenCalledWith(PAGE_SIZE);
    });

    it.each([
      [20, 20],
      [0, 1],
      [-5, 1],
      [MAX_PAGE + 1, MAX_PAGE],
    ])('answers a page of %i asked for as one of %i', async (asked, size) => {
      await service.list(PROJECT_ID, undefined, asked);
      expect(builder.limit).toHaveBeenCalledWith(size);
    });

    it('starts at the top when no cursor is given', async () => {
      await service.list(PROJECT_ID);
      expect(builder.andWhere).not.toHaveBeenCalled();
    });

    it('goes on after the cursor revision, found in the same project', async () => {
      await service.list(PROJECT_ID, 'r9', 10);
      expect(builder.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('cursor."id" = :before AND cursor."projectId" = :projectId'),
        { before: 'r9' },
      );
    });

    it('answers an empty page for a cursor it does not know (the subquery finds no row)', async () => {
      // The comparison with an empty subquery is null in SQL: no row passes. Here: the database's
      // answer is passed on as it is.
      builder.getMany.mockResolvedValue([]);
      await expect(service.list(PROJECT_ID, 'unknown')).resolves.toEqual([]);
    });
  });
});
