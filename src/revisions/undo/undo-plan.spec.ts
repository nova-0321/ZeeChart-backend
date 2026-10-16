import type { Revision } from '../entities/revision.entity.js';
import type {
  EventState,
  LinkState,
  ProjectState,
  Snapshot,
  TaskState,
} from '../history/revision-diff.js';
import {
  type BatchRow,
  currentOf,
  matches,
  plain,
  refusalOf,
  stepsOf,
  touchedBy,
  treeHolds,
  undoStacks,
} from './undo-plan.js';

// The decisions undo and redo make (#56), on plain data: no database, no mocks.

const PROJECT: ProjectState = { id: 'p1', name: 'Plan', description: null, archived: false };

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

const event = (id: string, fields: Partial<EventState> = {}): EventState => ({
  id,
  name: id,
  color: '#e0a030',
  startDate: '2026-11-10',
  endDate: '2026-11-10',
  ...fields,
});

const link = (id: string, fromTaskId: string, toTaskId: string): LinkState => ({
  id,
  fromTaskId,
  toTaskId,
  type: 'finish_to_start',
  lagDays: 0,
});

const snapshot = (
  parts: { tasks?: TaskState[]; events?: EventState[]; links?: LinkState[] } = {},
): Snapshot => ({
  project: PROJECT,
  tasks: new Map((parts.tasks ?? []).map((row) => [row.id, row])),
  events: new Map((parts.events ?? []).map((row) => [row.id, row])),
  links: parts.links ?? [],
});

const revision = (
  entityType: Revision['entityType'],
  entityId: string,
  before: object | null,
  after: object | null,
): Revision =>
  ({
    entityType,
    entityId,
    before,
    after,
    summary: 'Changed',
    primary: false,
  }) as Revision;

const change = (batchId: string): BatchRow => ({
  batchId,
  batchKind: 'change',
  ofBatch: null,
  creation: false,
});
const undo = (batchId: string, ofBatch: string): BatchRow => ({
  batchId,
  batchKind: 'undo',
  ofBatch,
  creation: false,
});
const redo = (batchId: string, ofBatch: string): BatchRow => ({
  batchId,
  batchKind: 'redo',
  ofBatch,
  creation: false,
});

describe('undoStacks', () => {
  it('puts a change on the undo stack', () => {
    expect(undoStacks([change('a')])).toEqual({ done: ['a'], undone: [] });
  });

  it('moves an undone batch to the redo stack', () => {
    expect(undoStacks([change('a'), undo('u1', 'a')])).toEqual({ done: [], undone: ['a'] });
  });

  it('puts a redone batch back as the redo batch, which a next undo reverts', () => {
    const redone = [change('a'), undo('u1', 'a'), redo('r1', 'a')];
    expect(undoStacks(redone)).toEqual({ done: ['r1'], undone: [] });
    expect(undoStacks([...redone, undo('u2', 'r1')])).toEqual({ done: [], undone: ['r1'] });
  });

  it('changes nothing for an undo or redo of a batch not on its stack', () => {
    expect(undoStacks([change('a'), undo('u1', 'other')])).toEqual({ done: ['a'], undone: [] });
    expect(undoStacks([change('a'), redo('r1', 'a')])).toEqual({ done: ['a'], undone: [] });
  });

  it('skips the batch that made the project', () => {
    expect(undoStacks([{ ...change('made'), creation: true }, change('a')])).toEqual({
      done: ['a'],
      undone: [],
    });
  });

  it('undoes the last changes first and redoes the last undone first', () => {
    const batches = [
      change('a'),
      change('b'),
      change('c'),
      undo('u1', 'c'),
      undo('u2', 'b'),
      redo('r1', 'b'),
    ];
    expect(undoStacks(batches)).toEqual({ done: ['a', 'r1'], undone: ['c'] });
  });

  it('clears the redo stack when a new change follows an undo', () => {
    expect(undoStacks([change('a'), undo('u1', 'a'), change('b')])).toEqual({
      done: ['b'],
      undone: [],
    });
  });
});

describe('stepsOf', () => {
  const rev = revision('task', 't1', { name: 'old' }, { name: 'new' });

  it('expects the after state and wants the before state for an undo', () => {
    expect(stepsOf([rev], 'undo')).toEqual([
      { revision: rev, expected: { name: 'new' }, wanted: { name: 'old' } },
    ]);
  });

  it('expects the before state and wants the after state for a redo', () => {
    expect(stepsOf([rev], 'redo')).toEqual([
      { revision: rev, expected: { name: 'old' }, wanted: { name: 'new' } },
    ]);
  });
});

describe('currentOf', () => {
  const now = snapshot({
    tasks: [task('t1')],
    events: [event('e1')],
    links: [link('l1', 't1', 't2')],
  });

  it('finds the task, event, link or project a revision is about', () => {
    expect(currentOf(now, revision('task', 't1', null, null))).toEqual(task('t1'));
    expect(currentOf(now, revision('event', 'e1', null, null))).toEqual(event('e1'));
    expect(currentOf(now, revision('link', 'l1', null, null))).toEqual(link('l1', 't1', 't2'));
    expect(currentOf(now, revision('project', 'p1', null, null))).toBe(PROJECT);
  });

  it('answers null for a row that is gone', () => {
    expect(currentOf(now, revision('task', 'gone', null, null))).toBeNull();
    expect(currentOf(now, revision('event', 'gone', null, null))).toBeNull();
    expect(currentOf(now, revision('link', 'gone', null, null))).toBeNull();
    expect(currentOf({ ...now, project: null }, revision('project', 'p1', null, null))).toBeNull();
  });
});

describe('matches', () => {
  it('holds when both are gone, and not when only one is', () => {
    expect(matches('task', null, null)).toBe(true);
    expect(matches('task', task('t1'), null)).toBe(false);
    expect(matches('task', null, task('t1'))).toBe(false);
  });

  it('holds when every followed field is the same', () => {
    expect(matches('task', task('t1'), task('t1'))).toBe(true);
    expect(matches('event', event('e1'), event('e1'))).toBe(true);
    expect(matches('link', link('l1', 'a', 'b'), link('l1', 'a', 'b'))).toBe(true);
    expect(matches('project', PROJECT, { ...PROJECT })).toBe(true);
  });

  it('fails when a followed field differs', () => {
    expect(matches('task', task('t1'), task('t1', { endDate: '2026-11-20' }))).toBe(false);
    expect(matches('event', event('e1'), event('e1', { color: '#000000' }))).toBe(false);
    expect(matches('link', link('l1', 'a', 'b'), { ...link('l1', 'a', 'b'), lagDays: 2 })).toBe(
      false,
    );
    expect(matches('project', PROJECT, { ...PROJECT, archived: true })).toBe(false);
  });

  it("ignores a field the history doesn't follow", () => {
    // A task's order changes when others are added or moved around it: not a change to it.
    expect(matches('task', task('t1', { order: 1 }), task('t1', { order: 5 }))).toBe(true);
  });
});

describe('refusalOf', () => {
  it('answers null when every row is as the batch left it', () => {
    const steps = stepsOf(
      [revision('task', 't1', task('t1'), task('t1', { progress: 50 }))],
      'undo',
    );
    expect(
      refusalOf(steps, snapshot({ tasks: [task('t1', { progress: 50 })] }), 'undo'),
    ).toBeNull();
  });

  it('names a row changed since', () => {
    const steps = stepsOf(
      [revision('task', 't1', task('t1', { name: 'Old' }), task('t1', { name: 'Draft' }))],
      'undo',
    );
    const now = snapshot({ tasks: [task('t1', { name: 'Final' })] });
    expect(refusalOf(steps, now, 'undo')).toBe("Can't undo: “Final” was changed since");
  });

  it('names the row as the batch left it when it is gone now', () => {
    const steps = stepsOf(
      [revision('task', 't1', task('t1', { name: 'Old' }), task('t1', { name: 'Draft' }))],
      'undo',
    );
    expect(refusalOf(steps, snapshot(), 'undo')).toBe("Can't undo: “Draft” was changed since");
  });

  it('says "something it changed" for a changed row without a name', () => {
    const steps = stepsOf([revision('link', 'l1', null, link('l1', 'a', 'b'))], 'undo');
    expect(refusalOf(steps, snapshot(), 'undo')).toBe(
      "Can't undo: something it changed was changed since",
    );
  });

  it('uses the direction in the message', () => {
    const steps = stepsOf([revision('task', 't1', task('t1'), task('t1', { name: 'B' }))], 'redo');
    expect(refusalOf(steps, snapshot({ tasks: [task('t1', { name: 'C' })] }), 'redo')).toBe(
      "Can't redo: “C” was changed since",
    );
  });

  it('refuses to remove a task someone put a task in since', () => {
    // Undoing the group's creation would delete it, and the other person's task with it.
    const group = task('g1', { name: 'Phase 1', type: 'group' });
    const steps = stepsOf([revision('task', 'g1', null, group)], 'undo');
    const now = snapshot({ tasks: [group, task('t2', { parentId: 'g1' })] });
    expect(refusalOf(steps, now, 'undo')).toBe(
      "Can't undo: “Phase 1” has tasks or links added since",
    );
  });

  it('refuses to remove a task someone linked since', () => {
    const made = task('t1', { name: 'Build' });
    const steps = stepsOf([revision('task', 't1', null, made)], 'undo');
    const now = snapshot({ tasks: [made, task('t2')], links: [link('l9', 't2', 't1')] });
    expect(refusalOf(steps, now, 'undo')).toBe(
      "Can't undo: “Build” has tasks or links added since",
    );
  });

  it("doesn't count tasks and links the batch itself made", () => {
    const group = task('g1', { type: 'group' });
    const child = task('t2', { parentId: 'g1' });
    const tie = link('l1', 't2', 'g1');
    const steps = stepsOf(
      [
        revision('task', 'g1', null, group),
        revision('task', 't2', null, child),
        revision('link', 'l1', null, tie),
      ],
      'undo',
    );
    expect(refusalOf(steps, snapshot({ tasks: [group, child], links: [tie] }), 'undo')).toBeNull();
  });
});

describe('touchedBy', () => {
  it('collects the groups and levels of the expected and wanted task states', () => {
    // A task moved from g1 back to the top level touches both lists and the group it left.
    const steps = stepsOf(
      [revision('task', 't1', task('t1', { parentId: null }), task('t1', { parentId: 'g1' }))],
      'undo',
    );
    const { groups, levels } = touchedBy(steps);
    expect([...groups]).toEqual(['g1']);
    expect([...levels].sort()).toEqual(['g1', null].sort());
  });

  it('adds a task that becomes a group itself', () => {
    const steps = stepsOf(
      [revision('task', 't1', task('t1'), task('t1', { type: 'group', parentId: 'g1' }))],
      'redo',
    );
    expect([...touchedBy(steps).groups].sort()).toEqual(['g1', 't1']);
  });

  it('ignores events, links and the project', () => {
    const steps = stepsOf(
      [
        revision('event', 'e1', null, event('e1')),
        revision('link', 'l1', null, link('l1', 'a', 'b')),
        revision('project', 'p1', PROJECT, { ...PROJECT, name: 'New' }),
      ],
      'undo',
    );
    const { groups, levels } = touchedBy(steps);
    expect(groups.size).toBe(0);
    expect(levels.size).toBe(0);
  });

  it('names the top level null', () => {
    const steps = stepsOf([revision('task', 't1', null, task('t1'))], 'undo');
    expect([...touchedBy(steps).levels]).toEqual([null]);
    expect(touchedBy(steps).groups.size).toBe(0);
  });
});

describe('treeHolds', () => {
  const row = (id: string, parentId: string | null, type = 'task') => ({ id, parentId, type });

  it('holds for tasks in groups in groups', () => {
    expect(
      treeHolds([
        row('g1', null, 'group'),
        row('g2', 'g1', 'group'),
        row('t1', 'g2'),
        row('t2', null),
      ]),
    ).toBe(true);
  });

  it('fails for a task whose group is missing', () => {
    expect(treeHolds([row('t1', 'gone')])).toBe(false);
  });

  it('fails for a task under a plain task', () => {
    expect(treeHolds([row('t0', null), row('t1', 't0')])).toBe(false);
  });

  it('fails, and ends, for a group inside itself', () => {
    expect(treeHolds([row('g1', 'g2', 'group'), row('g2', 'g1', 'group')])).toBe(false);
    expect(treeHolds([row('g1', 'g1', 'group')])).toBe(false);
  });

  it('fails, and ends, for a loop the task is not part of', () => {
    // t1 sits under a loop of groups: walking up never comes back to t1, the bound stops it.
    expect(treeHolds([row('t1', 'g1'), row('g1', 'g2', 'group'), row('g2', 'g1', 'group')])).toBe(
      false,
    );
  });
});

describe('plain', () => {
  it('strips the "Undo: " and "Redo: " a batch is noted with', () => {
    expect(plain('Undo: Renamed “A” to “B”')).toBe('Renamed “A” to “B”');
    expect(plain('Redo: Added “C”')).toBe('Added “C”');
    expect(plain('Added “C”')).toBe('Added “C”');
  });
});
