import {
  diffSnapshots,
  type EventState,
  type Snapshot,
  span,
  stateOf,
  type TaskState,
} from './revision-diff.js';

const task = (id: string, fields: Partial<TaskState> = {}): TaskState => ({
  id,
  name: id,
  description: null,
  type: 'task',
  priority: 'medium',
  startDate: '2026-10-05',
  endDate: '2026-10-09',
  progress: 0,
  color: '#2a78d6',
  order: 1,
  parentId: null,
  ...fields,
});
const event = (id: string, fields: Partial<EventState> = {}): EventState => ({
  id,
  name: id,
  color: '#e5484d',
  startDate: '2026-10-12',
  endDate: '2026-10-12',
  ...fields,
});
const snapshot = (
  tasks: TaskState[],
  events: EventState[] = [],
  project = { id: 'p', name: 'Launch', description: null, archived: false },
  links: Snapshot['links'] = [],
): Snapshot => ({
  project,
  tasks: new Map(tasks.map((t) => [t.id, t])),
  events: new Map(events.map((e) => [e.id, e])),
  links,
});

describe('diffSnapshots', () => {
  it('nothing changed: nothing recorded', () => {
    const s = snapshot([task('a')], [event('e')]);
    expect(diffSnapshots(s, snapshot([task('a')], [event('e')]))).toEqual([]);
  });

  it('a new task and a deleted one (keeping its links, to bring them back)', () => {
    const link = { fromTaskId: 'a', toTaskId: 'b', type: 'FS', lagDays: 0 };
    const before = snapshot([task('a'), task('b')], [], undefined, [link]);
    const after = snapshot([task('b'), task('c', { name: 'Ship' })]);
    const drafts = diffSnapshots(before, after);
    expect(drafts.map((d) => [d.entityId, d.action, d.summary])).toEqual([
      ['c', 'create', 'Added task “Ship”'],
      ['a', 'delete', 'Deleted task “a”'],
    ]);
    expect((drafts[1]!.before as TaskState).links).toEqual([link]);
  });

  it('an edit says what changed, in one sentence', () => {
    const before = snapshot([task('a', { name: 'Design' })]);
    const after = snapshot([
      task('a', {
        name: 'Design v2',
        startDate: '2026-10-07',
        endDate: '2026-10-13',
        progress: 40,
      }),
    ]);
    expect(diffSnapshots(before, after)[0]!.summary).toBe(
      'Renamed “Design” to “Design v2”; dates Oct 5–9 → Oct 7–13; progress 0% → 40%',
    );
  });

  it('a group stretched by the edit is recorded too', () => {
    const before = snapshot([
      task('g', { type: 'group', name: 'G' }),
      task('a', { parentId: 'g' }),
    ]);
    const after = snapshot([
      task('g', { type: 'group', name: 'G', endDate: '2026-10-20' }),
      task('a', { parentId: 'g', endDate: '2026-10-20' }),
    ]);
    const drafts = diffSnapshots(before, after, 'a');
    expect(drafts.map((d) => [d.entityId, d.primary ?? false])).toEqual([
      ['g', false],
      ['a', true],
    ]);
  });

  it('a move in the list: only the moved task, with its place before and after', () => {
    const before = snapshot([
      task('a', { order: 1 }),
      task('b', { order: 2 }),
      task('c', { order: 3 }),
    ]);
    const after = snapshot([
      task('a', { order: 2 }),
      task('b', { order: 3 }),
      task('c', { order: 1 }),
    ]);
    const drafts = diffSnapshots(before, after, 'c');
    expect(drafts.map((d) => [d.entityId, d.summary])).toEqual([['c', '“c”: Moved in the list']]);
    expect([(drafts[0]!.before as TaskState).place, (drafts[0]!.after as TaskState).place]).toEqual(
      [2, 0],
    );
    // With no row named (an undo, a redo, a restore): only the rows it put back at a place.
    expect(diffSnapshots(before, after)).toEqual([]);
    expect(diffSnapshots(before, after, undefined, new Set(['c'])).map((d) => d.entityId)).toEqual([
      'c',
    ]);
  });

  it('into a group, named; out of one', () => {
    const g = task('g', { type: 'group', name: 'Phase 1' });
    const into = diffSnapshots(
      snapshot([g, task('a')]),
      snapshot([g, task('a', { parentId: 'g' })]),
    );
    expect(into[0]!.summary).toBe('“a”: Moved into “Phase 1”');
    const out = diffSnapshots(
      snapshot([g, task('a', { parentId: 'g' })]),
      snapshot([g, task('a')]),
    );
    expect(out[0]!.summary).toBe('“a”: Moved out of its group');
  });

  it('events and the project', () => {
    const before = snapshot([], [event('e', { name: 'Freeze' })]);
    const after = snapshot([], [event('e', { name: 'Freeze', endDate: '2026-10-14' })], {
      id: 'p',
      name: 'Launch 2',
      description: null,
      archived: true,
    });
    expect(diffSnapshots(before, after).map((d) => d.summary)).toEqual([
      'Project renamed “Launch” to “Launch 2”; archived',
      'Event “Freeze”: dates Oct 12 → Oct 12–14',
    ]);
  });
});

describe('span', () => {
  it('one day, one month, two months, two years', () => {
    expect(span('2026-10-03', '2026-10-03')).toBe('Oct 3');
    expect(span('2026-10-03', '2026-10-07')).toBe('Oct 3–7');
    expect(span('2026-10-30', '2026-11-02')).toBe('Oct 30–Nov 2');
    expect(span('2026-12-30', '2027-01-02')).toBe('Dec 30, 2026–Jan 2, 2027');
  });
});

describe('stateOf', () => {
  it('after the change; for a deletion, just before it', () => {
    expect(stateOf({ action: 'update', before: { v: 1 }, after: { v: 2 } })).toEqual({ v: 2 });
    expect(stateOf({ action: 'delete', before: { v: 1 }, after: null })).toEqual({ v: 1 });
  });
});
