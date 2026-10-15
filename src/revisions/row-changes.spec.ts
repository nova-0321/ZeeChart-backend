import type { EntityManager } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CHANGED_ROWS } from '../realtime/realtime.types.js';
import type { Snapshot } from './history/revision-diff.js';
import { changedRows } from './row-changes.js';

// The rows a write changed (#75), from the snapshots before and after it. The rows themselves are
// read by their domains (stand-ins here: each answers the ids it was asked for).

const read = vi.hoisted(() => ({
  tasks: vi.fn(async (_: unknown, ids: string[]) => ids.map((id) => ({ id, kind: 'task' }))),
  links: vi.fn(async (_: unknown, ids: string[]) => ids.map((id) => ({ id, kind: 'link' }))),
  events: vi.fn(async (_: unknown, ids: string[]) => ids.map((id) => ({ id, kind: 'event' }))),
  project: vi.fn(async (_: unknown, id: string) => ({
    id,
    name: 'Plan',
    description: null,
    archived: false,
    version: 4,
  })),
}));
vi.mock('../tasks/task-rows.js', () => ({ tasksWithIds: read.tasks }));
vi.mock('../dependencies/link-rows.js', () => ({ linksWithIds: read.links }));
vi.mock('../events/event-rows.js', () => ({ eventsWithIds: read.events }));
vi.mock('../projects/project-rows.js', () => ({ projectFieldsOf: read.project }));

const manager = {} as EntityManager;
const PROJECT = { id: 'p1', name: 'Plan', description: null, archived: false };
const task = (id: string, fields: Record<string, unknown> = {}) => ({
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
const link = (id: string | undefined, from: string, to: string) => ({
  id,
  fromTaskId: from,
  toTaskId: to,
  type: 'FS',
  lagDays: 0,
});
const event = (id: string, name = id) => ({
  id,
  name,
  color: '#e5484d',
  startDate: '2026-11-16',
  endDate: '2026-11-18',
});

/** A snapshot of the project with these rows. */
const snapshot = (parts: {
  project?: typeof PROJECT | null;
  tasks?: ReturnType<typeof task>[];
  links?: ReturnType<typeof link>[];
  events?: ReturnType<typeof event>[];
}) =>
  ({
    project: parts.project === undefined ? PROJECT : parts.project,
    tasks: new Map((parts.tasks ?? []).map((row) => [row.id, row])),
    events: new Map((parts.events ?? []).map((row) => [row.id, row])),
    links: parts.links ?? [],
  }) as unknown as Snapshot;

beforeEach(() => Object.values(read).forEach((mock) => mock.mockClear()));

describe('changedRows', () => {
  it('nothing changed: {} (a version saved), and nothing read', async () => {
    const same = snapshot({
      tasks: [task('a')],
      links: [link('l1', 'a', 'b')],
      events: [event('e')],
    });
    expect(await changedRows(manager, 'p1', same, same)).toEqual({});
    expect(read.tasks).not.toHaveBeenCalled();
  });

  it('a changed task, a new one and a deleted one; the others are not in it', async () => {
    const before = snapshot({ tasks: [task('a'), task('b'), task('gone')] });
    const after = snapshot({
      tasks: [task('a', { endDate: '2026-11-09' }), task('b'), task('new')],
    });
    expect(await changedRows(manager, 'p1', before, after)).toEqual({
      tasks: {
        upsert: [
          { id: 'a', kind: 'task' },
          { id: 'new', kind: 'task' },
        ],
        delete: ['gone'],
      },
    });
  });

  it('a task only numbered again (its order) counts: the list order changed', async () => {
    const before = snapshot({ tasks: [task('a', { order: 1 }), task('b', { order: 2 })] });
    const after = snapshot({ tasks: [task('a', { order: 2 }), task('b', { order: 1 })] });
    const changes = await changedRows(manager, 'p1', before, after);
    expect(changes?.tasks?.upsert.map((row) => (row as { id: string }).id)).toEqual(['a', 'b']);
  });

  it('links and events: changed and deleted ones; a link without an id (old versions) is left out', async () => {
    const before = snapshot({
      links: [link('l1', 'a', 'b'), link('l2', 'b', 'c'), link(undefined, 'x', 'y')],
      events: [event('e1'), event('e2')],
    });
    const after = snapshot({
      links: [{ ...link('l1', 'a', 'b'), lagDays: 2 }],
      events: [event('e1', 'Launch day')],
    });
    expect(await changedRows(manager, 'p1', before, after)).toEqual({
      dependencies: { upsert: [{ id: 'l1', kind: 'link' }], delete: ['l2'] },
      events: { upsert: [{ id: 'e1', kind: 'event' }], delete: ['e2'] },
    });
  });

  it("the project's own fields, read again (with its version)", async () => {
    const before = snapshot({});
    const after = snapshot({ project: { ...PROJECT, archived: true } });
    expect(await changedRows(manager, 'p1', before, after)).toEqual({
      project: { id: 'p1', name: 'Plan', description: null, archived: false, version: 4 },
    });
    expect(read.project).toHaveBeenCalledWith(manager, 'p1');
  });

  it('the project changed but is gone when read: no project in it', async () => {
    read.project.mockResolvedValueOnce(null as never);
    const after = snapshot({ project: { ...PROJECT, name: 'Renamed' } });
    expect(await changedRows(manager, 'p1', snapshot({}), after)).toEqual({});
  });

  it(`over ${MAX_CHANGED_ROWS} rows: none (load the project again), and nothing read`, async () => {
    const many = Array.from({ length: MAX_CHANGED_ROWS + 1 }, (_, i) => task(`t${i}`));
    expect(await changedRows(manager, 'p1', snapshot({}), snapshot({ tasks: many }))).toBe(
      undefined,
    );
    expect(read.tasks).not.toHaveBeenCalled();
  });

  it(`exactly ${MAX_CHANGED_ROWS} rows: still sent`, async () => {
    const many = Array.from({ length: MAX_CHANGED_ROWS }, (_, i) => task(`t${i}`));
    const changes = await changedRows(manager, 'p1', snapshot({}), snapshot({ tasks: many }));
    expect(changes?.tasks?.upsert).toHaveLength(MAX_CHANGED_ROWS);
  });

  it('the project deleted: none (there is nothing left to show)', async () => {
    const before = snapshot({ tasks: [task('a')] });
    expect(await changedRows(manager, 'p1', before, snapshot({ project: null }))).toBe(undefined);
  });
});
