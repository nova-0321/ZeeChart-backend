import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { roleIn } from '../../members/membership.js';
import { Revision } from '../entities/revision.entity.js';
import { RestoreService } from './restore.service.js';
import type { EventState, TaskState } from './revision-diff.js';

// Who may restore a project's own revisions is read from the members domain.
vi.mock('../../members/membership.js', () => ({ roleIn: vi.fn() }));

const PROJECT_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const USER_ID = 'u1';
const GROUP_GONE =
  'its group (gone, no longer a group, or in a loop of groups): it stays where it is';

/** A task's state as a revision keeps it. */
const taskState = (extra: Partial<TaskState> = {}): TaskState => ({
  id: 't1',
  name: 'Design review',
  description: 'Walk through the mockups',
  type: 'task',
  priority: 'high',
  startDate: '2026-10-07',
  endDate: '2026-10-09',
  progress: 40,
  color: '#2a78d6',
  order: 3,
  parentId: null,
  ...extra,
});

/** A revision row: what it restores is `after`, or `before` for a deletion. */
const revision = (entityType: string, state: object | null, action = 'update') => ({
  id: 'r1',
  projectId: PROJECT_ID,
  entityType,
  entityId: (state as { id?: string } | null)?.id ?? PROJECT_ID,
  version: 4,
  action,
  before: action === 'delete' ? state : null,
  after: action === 'delete' ? null : state,
});

describe('RestoreService.restore', () => {
  const revisionRepo = { findOneBy: vi.fn() };
  const manager = {};
  const tx = { repo: vi.fn(), manager, run: (work: () => unknown) => work() };
  const tasks = {
    find: vi.fn(),
    canHold: vi.fn(),
    recreate: vi.fn(),
    childCount: vi.fn(),
    setParent: vi.fn(),
    changeType: vi.fn(),
    update: vi.fn(),
  };
  const events = { exists: vi.fn(), update: vi.fn(), recreate: vi.fn() };
  const projects = { update: vi.fn() };
  const links = { create: vi.fn() };
  let service: RestoreService;

  /** Every write a restore can make, to check that none was made. */
  const writes = () => [
    tasks.recreate,
    tasks.setParent,
    tasks.changeType,
    tasks.update,
    links.create,
    events.update,
    events.recreate,
    projects.update,
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    tx.repo.mockReturnValue(revisionRepo);
    tasks.canHold.mockResolvedValue(true);
    tasks.childCount.mockResolvedValue(0);
    service = new RestoreService(
      tx as never,
      tasks as never,
      events as never,
      projects as never,
      links as never,
    );
  });

  describe('the revision', () => {
    it('answers 404 for a revision that does not exist', async () => {
      revisionRepo.findOneBy.mockResolvedValue(null);
      await expect(service.restore('r1', USER_ID)).rejects.toThrow(
        new NotFoundException('Revision not found'),
      );
      expect(tx.repo).toHaveBeenCalledWith(Revision);
      expect(revisionRepo.findOneBy).toHaveBeenCalledWith({ id: 'r1' });
    });

    it('refuses a revision with no state to bring back, writing nothing', async () => {
      // A creation's `before` is null and a deletion restores `before`: here `after` is null.
      revisionRepo.findOneBy.mockResolvedValue(revision('task', null));
      await expect(service.restore('r1', USER_ID)).rejects.toThrow(
        new BadRequestException('This revision has nothing to restore'),
      );
      for (const write of writes()) expect(write).not.toHaveBeenCalled();
    });

    it('answers which entity was restored, to which version, with nothing skipped', async () => {
      revisionRepo.findOneBy.mockResolvedValue(revision('task', taskState()));
      tasks.find.mockResolvedValue({ id: 't1', type: 'task', parentId: null });
      await expect(service.restore('r1', USER_ID)).resolves.toEqual({
        entityType: 'task',
        entityId: 't1',
        version: 4,
        skipped: [],
      });
    });
  });

  describe('a task that was deleted since', () => {
    beforeEach(() => tasks.find.mockResolvedValue(null));

    it('is made again with its own id and the fields it had', async () => {
      revisionRepo.findOneBy.mockResolvedValue(revision('task', taskState(), 'delete'));
      await service.restore('r1', USER_ID);
      expect(tasks.recreate).toHaveBeenCalledWith({
        id: 't1',
        projectId: PROJECT_ID,
        name: 'Design review',
        description: 'Walk through the mockups',
        type: 'task',
        priority: 'high',
        startDate: '2026-10-07',
        endDate: '2026-10-09',
        progress: 40,
        color: '#2a78d6',
        order: 3,
        parentId: null,
      });
      expect(tasks.update).not.toHaveBeenCalled();
    });

    it('makes a milestone again ending on its start day, with no description when it had none', async () => {
      revisionRepo.findOneBy.mockResolvedValue(
        revision(
          'task',
          taskState({ type: 'milestone', endDate: '2026-10-20', description: null }),
          'delete',
        ),
      );
      await service.restore('r1', USER_ID);
      expect(tasks.recreate).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'milestone',
          startDate: '2026-10-07',
          endDate: '2026-10-07',
          description: undefined,
        }),
      );
    });

    it('puts it back in its group when the group can still hold it', async () => {
      revisionRepo.findOneBy.mockResolvedValue(
        revision('task', taskState({ parentId: 'g1' }), 'delete'),
      );
      const result = await service.restore('r1', USER_ID);
      expect(tasks.canHold).toHaveBeenCalledWith(PROJECT_ID, 'g1', 't1');
      expect(tasks.recreate).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'g1' }));
      expect(result.skipped).toEqual([]);
    });

    it('makes it again at the top level when its group can no longer hold it, and says so', async () => {
      revisionRepo.findOneBy.mockResolvedValue(
        revision('task', taskState({ parentId: 'g1' }), 'delete'),
      );
      tasks.canHold.mockResolvedValue(false);
      const result = await service.restore('r1', USER_ID);
      expect(tasks.recreate).toHaveBeenCalledWith(expect.objectContaining({ parentId: null }));
      expect(result.skipped).toEqual([GROUP_GONE]);
    });

    it('makes its links again, as new links are made', async () => {
      const state = taskState({
        links: [
          { id: 'l1', fromTaskId: 't0', toTaskId: 't1', type: 'FS', lagDays: 2 },
          { fromTaskId: 't1', toTaskId: 't2', type: 'SS', lagDays: 0 },
        ],
      });
      revisionRepo.findOneBy.mockResolvedValue(revision('task', state, 'delete'));
      const result = await service.restore('r1', USER_ID);
      expect(links.create).toHaveBeenNthCalledWith(1, {
        fromTaskId: 't0',
        toTaskId: 't1',
        type: 'FS',
        lagDays: 2,
      });
      expect(links.create).toHaveBeenNthCalledWith(2, {
        fromTaskId: 't1',
        toTaskId: 't2',
        type: 'SS',
        lagDays: 0,
      });
      // The task comes first, so its links have both ends.
      expect(tasks.recreate.mock.invocationCallOrder[0]).toBeLessThan(
        links.create.mock.invocationCallOrder[0],
      );
      expect(result.skipped).toEqual([]);
    });

    it('skips a link that can no longer be made, says why, and still makes the others', async () => {
      const state = taskState({
        links: [
          { fromTaskId: 'gone', toTaskId: 't1', type: 'FS', lagDays: 0 },
          { fromTaskId: 't1', toTaskId: 't2', type: 'FS', lagDays: 0 },
        ],
      });
      revisionRepo.findOneBy.mockResolvedValue(revision('task', state, 'delete'));
      links.create.mockRejectedValueOnce(new NotFoundException('Task not found'));
      const result = await service.restore('r1', USER_ID);
      expect(links.create).toHaveBeenCalledTimes(2);
      expect(result.skipped).toEqual([
        'a link (the task at its other end is gone, or the link no longer fits)',
      ]);
    });

    it('makes no links when it had none', async () => {
      revisionRepo.findOneBy.mockResolvedValue(revision('task', taskState(), 'delete'));
      await service.restore('r1', USER_ID);
      expect(links.create).not.toHaveBeenCalled();
    });
  });

  describe('a task that is still there', () => {
    it('writes back the fields it had, a null description clearing the one it has now', async () => {
      revisionRepo.findOneBy.mockResolvedValue(revision('task', taskState({ description: null })));
      tasks.find.mockResolvedValue({ id: 't1', type: 'task', parentId: null });
      await service.restore('r1', USER_ID);
      expect(tasks.update).toHaveBeenCalledWith('t1', {
        name: 'Design review',
        description: null,
        priority: 'high',
        progress: 40,
        color: '#2a78d6',
        startDate: '2026-10-07',
        endDate: '2026-10-09',
      });
      expect(tasks.recreate).not.toHaveBeenCalled();
      expect(tasks.setParent).not.toHaveBeenCalled();
      expect(tasks.changeType).not.toHaveBeenCalled();
    });

    it("restores a group's fields without its progress: that is its tasks' average again (#80)", async () => {
      revisionRepo.findOneBy.mockResolvedValue(
        revision('task', taskState({ type: 'group', progress: 90 })),
      );
      tasks.find.mockResolvedValue({ id: 't1', type: 'group', parentId: null });
      await service.restore('r1', USER_ID);
      const [, fields] = tasks.update.mock.calls[0] as [string, Record<string, unknown>];
      expect(fields).not.toHaveProperty('progress');
      expect(fields).toMatchObject({ name: 'Design review', color: '#2a78d6' });
    });

    it('moves it back into its old group at the place it had there', async () => {
      revisionRepo.findOneBy.mockResolvedValue(
        revision('task', taskState({ parentId: 'g1', order: 3 })),
      );
      tasks.find.mockResolvedValue({ id: 't1', type: 'task', parentId: null });
      await service.restore('r1', USER_ID);
      // setParent takes a place counted from 0; order counts from 1.
      expect(tasks.setParent).toHaveBeenCalledWith('t1', 'g1', 2);
    });

    it('moves it out to the top level when it was there then', async () => {
      revisionRepo.findOneBy.mockResolvedValue(revision('task', taskState({ order: 1 })));
      tasks.find.mockResolvedValue({ id: 't1', type: 'task', parentId: 'g1' });
      await service.restore('r1', USER_ID);
      expect(tasks.canHold).not.toHaveBeenCalled();
      expect(tasks.setParent).toHaveBeenCalledWith('t1', null, 0);
    });

    it('leaves it in the group it is in now when its old group can no longer hold it, and says so', async () => {
      revisionRepo.findOneBy.mockResolvedValue(revision('task', taskState({ parentId: 'g1' })));
      tasks.find.mockResolvedValue({ id: 't1', type: 'task', parentId: 'g2' });
      tasks.canHold.mockResolvedValue(false);
      const result = await service.restore('r1', USER_ID);
      expect(tasks.setParent).not.toHaveBeenCalled();
      expect(tasks.update).toHaveBeenCalled();
      expect(result.skipped).toEqual([GROUP_GONE]);
    });

    it('changes its type back before writing its fields', async () => {
      revisionRepo.findOneBy.mockResolvedValue(revision('task', taskState({ type: 'milestone' })));
      tasks.find.mockResolvedValue({ id: 't1', type: 'task', parentId: null });
      await service.restore('r1', USER_ID);
      expect(tasks.changeType).toHaveBeenCalledWith('t1', 'milestone');
      expect(tasks.changeType.mock.invocationCallOrder[0]).toBeLessThan(
        tasks.update.mock.invocationCallOrder[0],
      );
    });

    it('refuses to turn a group with tasks in it back into a task, writing nothing', async () => {
      revisionRepo.findOneBy.mockResolvedValue(revision('task', taskState({ parentId: 'g9' })));
      tasks.find.mockResolvedValue({ id: 't1', type: 'group', parentId: null });
      tasks.childCount.mockResolvedValue(2);
      await expect(service.restore('r1', USER_ID)).rejects.toThrow(
        new BadRequestException(
          'This group has tasks in it now. Move them out before restoring it as a task',
        ),
      );
      expect(tasks.childCount).toHaveBeenCalledWith('t1');
      for (const write of writes()) expect(write).not.toHaveBeenCalled();
    });

    it('turns an empty group back into a task', async () => {
      revisionRepo.findOneBy.mockResolvedValue(revision('task', taskState()));
      tasks.find.mockResolvedValue({ id: 't1', type: 'group', parentId: null });
      await service.restore('r1', USER_ID);
      expect(tasks.changeType).toHaveBeenCalledWith('t1', 'task');
      expect(tasks.update).toHaveBeenCalled();
    });

    it('does not count the tasks of a group restored as a group', async () => {
      revisionRepo.findOneBy.mockResolvedValue(revision('task', taskState({ type: 'group' })));
      tasks.find.mockResolvedValue({ id: 't1', type: 'group', parentId: null });
      await service.restore('r1', USER_ID);
      expect(tasks.childCount).not.toHaveBeenCalled();
      expect(tasks.changeType).not.toHaveBeenCalled();
    });

    it('lets a refused step fail the whole restore, so nothing after it is written', async () => {
      // A link may not allow the move into its group: the transaction undoes the restore.
      revisionRepo.findOneBy.mockResolvedValue(revision('task', taskState({ parentId: 'g1' })));
      tasks.find.mockResolvedValue({ id: 't1', type: 'task', parentId: null });
      tasks.setParent.mockRejectedValue(new BadRequestException('A link does not allow it'));
      await expect(service.restore('r1', USER_ID)).rejects.toThrow('A link does not allow it');
      expect(tasks.changeType).not.toHaveBeenCalled();
      expect(tasks.update).not.toHaveBeenCalled();
    });
  });

  describe('an event', () => {
    const event: EventState = {
      id: 'e1',
      name: 'Launch',
      color: '#e0a030',
      startDate: '2026-11-01',
      endDate: '2026-11-02',
    };
    const fields = {
      name: event.name,
      color: event.color,
      startDate: event.startDate,
      endDate: event.endDate,
    };

    it('writes back the fields of an event that is still there', async () => {
      revisionRepo.findOneBy.mockResolvedValue(revision('event', event));
      events.exists.mockResolvedValue(true);
      await service.restore('r1', USER_ID);
      expect(events.exists).toHaveBeenCalledWith('e1');
      expect(events.update).toHaveBeenCalledWith('e1', fields);
      expect(events.recreate).not.toHaveBeenCalled();
    });

    it('makes a deleted event again with its own id, in the revision’s project', async () => {
      revisionRepo.findOneBy.mockResolvedValue(revision('event', event, 'delete'));
      events.exists.mockResolvedValue(false);
      await service.restore('r1', USER_ID);
      expect(events.recreate).toHaveBeenCalledWith('e1', PROJECT_ID, fields);
      expect(events.update).not.toHaveBeenCalled();
    });
  });

  describe('a link', () => {
    it('is not restored alone: it comes back with its task, or with undo', async () => {
      revisionRepo.findOneBy.mockResolvedValue(
        revision('link', { id: 'l1', fromTaskId: 't0', toTaskId: 't1', type: 'FS', lagDays: 0 }),
      );
      await expect(service.restore('r1', USER_ID)).rejects.toThrow(
        new BadRequestException('A link is restored with its task, or with undo'),
      );
      for (const write of writes()) expect(write).not.toHaveBeenCalled();
    });
  });

  describe('the project', () => {
    const project = { id: PROJECT_ID, name: 'Plan', description: null, archived: true };

    it('puts back its name, description and archived flag for an owner', async () => {
      revisionRepo.findOneBy.mockResolvedValue(revision('project', project));
      vi.mocked(roleIn).mockResolvedValue('owner');
      await service.restore('r1', USER_ID);
      expect(roleIn).toHaveBeenCalledWith(manager, PROJECT_ID, USER_ID);
      // A null description clears the one it has now.
      expect(projects.update).toHaveBeenCalledWith(
        PROJECT_ID,
        { name: 'Plan', description: null, archived: true },
        USER_ID,
      );
    });

    it.each(['editor', 'viewer', null] as const)(
      'refuses with 403 when the user is %s, writing nothing',
      async (role) => {
        revisionRepo.findOneBy.mockResolvedValue(revision('project', project));
        vi.mocked(roleIn).mockResolvedValue(role);
        await expect(service.restore('r1', USER_ID)).rejects.toThrow(
          new ForbiddenException('Only an owner of this project can do this'),
        );
        expect(projects.update).not.toHaveBeenCalled();
      },
    );
  });
});
