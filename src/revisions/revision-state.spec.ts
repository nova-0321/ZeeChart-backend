import type { Snapshot, TaskState } from './history/revision-diff.js';
import { withProgress } from './revision-state.js';

// withProgress (#83): the groups' saved progress put into the snapshot read after the write, so
// the history and the change message see it without reading the project again.

const task = (id: string, progress: number): TaskState =>
  ({ id, name: id, type: 'group', progress, parentId: null }) as TaskState;

const snapshot = (...tasks: TaskState[]): Snapshot => ({
  project: null,
  tasks: new Map(tasks.map((row) => [row.id, row])),
  events: new Map(),
  links: [],
});

describe('withProgress', () => {
  it('sets the new progress on the changed groups only, in a new snapshot', () => {
    const read = snapshot(task('g', 0), task('h', 30));

    const after = withProgress(read, [{ id: 'g', progress: 40 }]);

    expect(after.tasks.get('g')?.progress).toBe(40);
    expect(after.tasks.get('h')).toBe(read.tasks.get('h'));
    // The snapshot read is left as it was.
    expect(read.tasks.get('g')?.progress).toBe(0);
  });

  it('gives the same snapshot back when nothing changed', () => {
    const read = snapshot(task('g', 50));
    expect(withProgress(read, [])).toBe(read);
  });

  it('skips a change for a task the snapshot does not have', () => {
    const after = withProgress(snapshot(task('g', 10)), [{ id: 'gone', progress: 70 }]);
    expect([...after.tasks.keys()]).toEqual(['g']);
  });
});
