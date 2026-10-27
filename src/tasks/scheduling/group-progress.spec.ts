import { groupProgress, progressChanges, type ProgressRow } from './group-progress.js';

// A group's progress is the average of its tasks (#80), worked out on plain rows.

const task = (id: string, progress: number, parentId: string | null = null): ProgressRow => ({
  id,
  parentId,
  type: 'task',
  progress,
});
const group = (id: string, parentId: string | null = null, progress = 0): ProgressRow => ({
  id,
  parentId,
  type: 'group',
  progress,
});
const milestone = (id: string, parentId: string | null): ProgressRow => ({
  id,
  parentId,
  type: 'milestone',
  progress: 100,
});

describe('groupProgress', () => {
  it("is the plain mean of the group's tasks, each counting the same", () => {
    const rows = [group('g'), task('a', 100, 'g'), task('b', 0, 'g'), task('c', 50, 'g')];
    expect(groupProgress(rows).get('g')).toBe(50);
  });

  it('counts a group inside it with its own average, worked out first', () => {
    // g holds a (100) and h; h holds b (0) and c (50), so h is 25 and g is (100 + 25) / 2.
    const rows = [
      group('g'),
      task('a', 100, 'g'),
      group('h', 'g', 90),
      task('b', 0, 'h'),
      task('c', 50, 'h'),
    ];
    expect(Object.fromEntries(groupProgress(rows))).toEqual({ g: 63, h: 25 });
  });

  it('leaves milestones out, and only tasks of the group itself count (not the top level)', () => {
    const rows = [group('g'), task('a', 40, 'g'), milestone('m', 'g'), task('outside', 100)];
    expect(groupProgress(rows).get('g')).toBe(40);
  });

  it('is 0 for a group with nothing to count: no tasks, or only milestones', () => {
    const rows = [
      group('empty', null, 70),
      group('only-milestones', null, 30),
      milestone('m', 'only-milestones'),
    ];
    expect(Object.fromEntries(groupProgress(rows))).toEqual({ empty: 0, 'only-milestones': 0 });
  });

  it('rounds to a whole percent', () => {
    expect(
      groupProgress([group('g'), task('a', 100, 'g'), task('b', 0, 'g'), task('c', 0, 'g')]).get(
        'g',
      ),
    ).toBe(33);
    expect(
      groupProgress([group('g'), task('a', 100, 'g'), task('b', 100, 'g'), task('c', 0, 'g')]).get(
        'g',
      ),
    ).toBe(67);
    expect(groupProgress([group('g'), task('a', 1, 'g'), task('b', 0, 'g')]).get('g')).toBe(1);
  });

  it('ends on groups that loop into each other (old data), counting the loop as 0', () => {
    // p inside q inside p: no group above the other, but each has a task.
    const rows = [group('p', 'q'), group('q', 'p'), task('a', 80, 'p'), task('b', 40, 'q')];
    const result = groupProgress(rows);
    expect([...result.keys()].sort()).toEqual(['p', 'q']);
    for (const value of result.values()) expect(value).toBeGreaterThanOrEqual(0);
  });

  it('works out every group, nothing else', () => {
    expect([...groupProgress([task('a', 10), group('g'), task('b', 20, 'g')]).keys()]).toEqual([
      'g',
    ]);
  });
});

describe('progressChanges', () => {
  it('lists only the groups whose stored progress is not their average yet', () => {
    const rows = [
      group('right', null, 50),
      task('a', 50, 'right'),
      group('stale', null, 10),
      task('b', 90, 'stale'),
    ];
    expect(progressChanges(rows)).toEqual([{ id: 'stale', progress: 90 }]);
  });

  it('nothing when every group is right', () => {
    expect(progressChanges([group('g', null, 30), task('a', 30, 'g')])).toEqual([]);
  });
});
