import {
  isBroken,
  planAttach,
  planEdit,
  planRefit,
  planSettle,
  planReschedule,
  ScheduleError,
  type ScheduleLink,
  type ScheduleTask,
} from './schedule.js';

const task = (
  id: string,
  startDate: string,
  endDate: string,
  extra: Partial<ScheduleTask> = {},
): ScheduleTask => ({ id, name: id, parentId: null, type: 'task', startDate, endDate, ...extra });

const link = (fromTaskId: string, toTaskId: string, type = 'FS', lagDays = 0): ScheduleLink => ({
  fromTaskId,
  toTaskId,
  type,
  lagDays,
});

const dates = (changes: Map<string, { startDate: string; endDate: string }>, id: string) =>
  changes.has(id) ? `${changes.get(id)!.startDate}..${changes.get(id)!.endDate}` : undefined;

describe('isBroken', () => {
  const a = { startDate: '2026-10-05', endDate: '2026-10-07' };

  it('FS: the successor must start the day after the predecessor ends, plus the lag', () => {
    const fs = { type: 'FS', lagDays: 0 };
    expect(isBroken(fs, a, { startDate: '2026-10-07', endDate: '2026-10-09' })).toBe(true);
    expect(isBroken(fs, a, { startDate: '2026-10-08', endDate: '2026-10-09' })).toBe(false);
    expect(
      isBroken({ type: 'FS', lagDays: 2 }, a, { startDate: '2026-10-09', endDate: '2026-10-10' }),
    ).toBe(true);
    expect(
      isBroken({ type: 'FS', lagDays: 2 }, a, { startDate: '2026-10-10', endDate: '2026-10-11' }),
    ).toBe(false);
  });

  it('FS with a lead lets the successor overlap the predecessor', () => {
    expect(
      isBroken({ type: 'FS', lagDays: -1 }, a, { startDate: '2026-10-07', endDate: '2026-10-09' }),
    ).toBe(false);
  });

  it('SS, FF and SF compare the matching ends', () => {
    const b = { startDate: '2026-10-05', endDate: '2026-10-06' };
    expect(
      isBroken({ type: 'SS', lagDays: 0 }, a, { startDate: '2026-10-04', endDate: '2026-10-09' }),
    ).toBe(true);
    expect(isBroken({ type: 'FF', lagDays: 0 }, a, b)).toBe(true);
    expect(
      isBroken({ type: 'SF', lagDays: 0 }, a, { startDate: '2026-10-01', endDate: '2026-10-04' }),
    ).toBe(true);
    expect(
      isBroken({ type: 'SF', lagDays: 0 }, a, { startDate: '2026-10-01', endDate: '2026-10-05' }),
    ).toBe(false);
  });
});

describe('planReschedule', () => {
  it('pushes a too-early successor to the day after the predecessor plus the lag', () => {
    const tasks = [task('a', '2026-10-05', '2026-10-07'), task('b', '2026-10-06', '2026-10-08')];
    const changes = planReschedule(tasks, [link('a', 'b', 'FS', 2)], ['a']);
    // starts 7 + 1 + 2 = Oct 10, still 3 days long
    expect(dates(changes, 'b')).toBe('2026-10-10..2026-10-12');
    expect(changes.has('a')).toBe(false);
  });

  it('leaves a successor that is already late enough', () => {
    const tasks = [task('a', '2026-10-05', '2026-10-07'), task('b', '2026-10-20', '2026-10-22')];
    expect(planReschedule(tasks, [link('a', 'b')], ['a']).size).toBe(0);
  });

  it('passes the push down a chain and respects the strictest of several predecessors', () => {
    const tasks = [
      task('a', '2026-10-05', '2026-10-07'),
      task('x', '2026-10-05', '2026-10-20'),
      task('b', '2026-10-08', '2026-10-09'),
      task('c', '2026-10-10', '2026-10-11'),
    ];
    const links = [link('a', 'b'), link('b', 'c'), link('x', 'b')];
    const changes = planReschedule(tasks, links, ['a', 'x']);
    expect(dates(changes, 'b')).toBe('2026-10-21..2026-10-22');
    expect(dates(changes, 'c')).toBe('2026-10-23..2026-10-24');
  });

  it('moves a successor group together with its tasks, and keeps their gaps', () => {
    const tasks = [
      task('a', '2026-10-05', '2026-10-07'),
      task('g', '2026-10-06', '2026-10-12', { type: 'group' }),
      task('c1', '2026-10-06', '2026-10-08', { parentId: 'g' }),
      task('c2', '2026-10-10', '2026-10-12', { parentId: 'g' }),
    ];
    const changes = planReschedule(tasks, [link('a', 'g')], ['a']);
    expect(dates(changes, 'g')).toBe('2026-10-08..2026-10-14');
    expect(dates(changes, 'c1')).toBe('2026-10-08..2026-10-10');
    expect(dates(changes, 'c2')).toBe('2026-10-12..2026-10-14');
  });

  it('stretches the group of a pushed task so the task stays inside it', () => {
    const tasks = [
      task('a', '2026-10-05', '2026-10-07'),
      task('g', '2026-10-01', '2026-10-10', { type: 'group' }),
      task('k', '2026-10-01', '2026-10-03', { parentId: 'g' }),
      task('c', '2026-10-08', '2026-10-10', { parentId: 'g' }),
    ];
    const changes = planReschedule(tasks, [link('a', 'c', 'FS', 5)], ['a']);
    expect(dates(changes, 'c')).toBe('2026-10-13..2026-10-15');
    expect(dates(changes, 'g')).toBe('2026-10-01..2026-10-15');
  });

  it('gives up, with a message, when a group and a task of it would push each other forever', () => {
    const tasks = [
      task('g', '2026-10-01', '2026-10-10', { type: 'group' }),
      task('c', '2026-10-01', '2026-10-10', { parentId: 'g' }),
      task('a', '2026-10-12', '2026-10-14'),
    ];
    // g -> a and a -> c: c is pushed after a, which stretches g, which pushes a again...
    expect(() => planReschedule(tasks, [link('g', 'a'), link('a', 'c')], ['a'])).toThrow(
      /keep pushing each other/,
    );
  });

  it('never gives a task an end before its start', () => {
    const tasks = [task('a', '2026-10-05', '2026-10-30'), task('b', '2026-10-06', '2026-10-06')];
    for (const type of ['FS', 'SS', 'FF', 'SF']) {
      for (const lag of [-30, -3, 0, 4, 40]) {
        const changes = planReschedule(tasks, [link('a', 'b', type, lag)], ['a']);
        const b = changes.get('b');
        if (b) expect(b.endDate >= b.startDate).toBe(true);
      }
    }
  });
});

describe('planEdit', () => {
  const tasks = [
    task('a', '2026-10-05', '2026-10-07'),
    task('b', '2026-10-10', '2026-10-12'),
    task('c', '2026-10-14', '2026-10-15'),
  ];
  const links = [link('a', 'b'), link('b', 'c')];

  it('moving a predecessor later pushes the successors', () => {
    const changes = planEdit(tasks, links, 'a', '2026-10-12', '2026-10-14');
    expect(dates(changes, 'a')).toBe('2026-10-12..2026-10-14');
    expect(dates(changes, 'b')).toBe('2026-10-15..2026-10-17');
    expect(dates(changes, 'c')).toBe('2026-10-18..2026-10-19');
  });

  it('moving a successor too early stops at the earliest allowed day', () => {
    const changes = planEdit(tasks, [link('a', 'b', 'FS', 1)], 'b', '2026-10-01', '2026-10-03');
    expect(dates(changes, 'b')).toBe('2026-10-09..2026-10-11');
  });

  it('reports the edited task even when it is clamped back to where it was', () => {
    const changes = planEdit(tasks, [link('a', 'b', 'FS', 2)], 'b', '2026-10-01', '2026-10-03');
    expect(dates(changes, 'b')).toBe('2026-10-10..2026-10-12');
  });

  it('refuses a resize that would put the start before the predecessor allows', () => {
    expect(() => planEdit(tasks, links, 'b', '2026-10-06', '2026-10-12')).toThrow(ScheduleError);
    expect(() => planEdit(tasks, links, 'b', '2026-10-06', '2026-10-12')).toThrow(
      /start on or after 2026-10-08/,
    );
  });

  it('refuses an end before the start', () => {
    expect(() => planEdit(tasks, links, 'a', '2026-10-09', '2026-10-08')).toThrow(ScheduleError);
  });

  it('refuses a resize of an FF successor whose end would be too early, and says it is the end', () => {
    expect(() =>
      planEdit(tasks, [link('a', 'b', 'FF', 3)], 'b', '2026-10-08', '2026-10-09'),
    ).toThrow(/end on or after 2026-10-10/);
  });

  it('moves a group with its tasks, and a task of a group stretches the group', () => {
    const grouped = [
      task('g', '2026-10-05', '2026-10-12', { type: 'group' }),
      task('c1', '2026-10-05', '2026-10-07', { parentId: 'g' }),
      task('c2', '2026-10-10', '2026-10-12', { parentId: 'g' }),
    ];
    const moved = planEdit(grouped, [], 'g', '2026-10-08', '2026-10-15');
    expect(dates(moved, 'c1')).toBe('2026-10-08..2026-10-10');
    expect(dates(moved, 'c2')).toBe('2026-10-13..2026-10-15');

    const stretched = planEdit(grouped, [], 'c2', '2026-10-14', '2026-10-16');
    expect(dates(stretched, 'g')).toBe('2026-10-05..2026-10-16');
  });

  it('a group with tasks keeps their length: no shorter, no longer; it can still be moved', () => {
    const grouped = [
      task('g', '2026-10-05', '2026-10-12', { type: 'group' }),
      task('c1', '2026-10-05', '2026-10-07', { parentId: 'g' }),
      task('c2', '2026-10-10', '2026-10-12', { parentId: 'g' }),
    ];
    expect(() => planEdit(grouped, [], 'g', '2026-10-05', '2026-10-11')).toThrow(
      /length follows its tasks \(2026-10-05 to 2026-10-12\)/,
    );
    expect(() => planEdit(grouped, [], 'g', '2026-10-06', '2026-10-12')).toThrow(/follows/);
    expect(() => planEdit(grouped, [], 'g', '2026-10-04', '2026-10-14')).toThrow(/follows/);
    expect(dates(planEdit(grouped, [], 'g', '2026-10-05', '2026-10-12'), 'g')).toBe(
      '2026-10-05..2026-10-12',
    );
    // Moved as a whole (the same length): the tasks go with it.
    const moved = planEdit(grouped, [], 'g', '2026-10-07', '2026-10-14');
    expect([dates(moved, 'g'), dates(moved, 'c1'), dates(moved, 'c2')]).toEqual([
      '2026-10-07..2026-10-14',
      '2026-10-07..2026-10-09',
      '2026-10-12..2026-10-14',
    ]);
  });

  it('moving a group clamps by the links into any of its tasks', () => {
    const grouped = [
      task('p', '2026-10-01', '2026-10-10'),
      task('g', '2026-10-12', '2026-10-15', { type: 'group' }),
      task('c', '2026-10-12', '2026-10-15', { parentId: 'g' }),
    ];
    const changes = planEdit(grouped, [link('p', 'c')], 'g', '2026-10-05', '2026-10-08');
    expect(dates(changes, 'g')).toBe('2026-10-11..2026-10-14');
    expect(dates(changes, 'c')).toBe('2026-10-11..2026-10-14');
  });
});

describe('planAttach', () => {
  const group = task('g', '2026-01-01', '2026-01-10', { type: 'group' });

  // A group is exactly the days of its tasks, so these have a task that fills them.
  const filler = task('k', '2026-01-01', '2026-01-10', { parentId: 'g' });

  it('stretches the group so it covers the task put in it', () => {
    const tasks = [group, filler, task('t', '2026-03-01', '2026-03-05', { parentId: 'g' })];
    expect(dates(planAttach(tasks, [], 't'), 'g')).toBe('2026-01-01..2026-03-05');
  });

  it('shrinks the group the task left, and the group above it', () => {
    // t was in g and is now top-level: g is only what k covers, and so is the group around g.
    const tasks = [
      task('top', '2026-01-01', '2026-03-05', { type: 'group' }),
      task('g', '2026-01-01', '2026-03-05', { type: 'group', parentId: 'top' }),
      task('k', '2026-01-01', '2026-01-10', { parentId: 'g' }),
      task('t', '2026-03-01', '2026-03-05'),
    ];
    const changes = planAttach(tasks, [], 't', 'g');
    expect(dates(changes, 'g')).toBe('2026-01-01..2026-01-10');
    expect(dates(changes, 'top')).toBe('2026-01-01..2026-01-10');
  });

  it('fits a group to what is left after a task was removed', () => {
    const tasks = [
      task('g', '2026-01-01', '2026-03-05', { type: 'group' }),
      task('k', '2026-01-01', '2026-01-10', { parentId: 'g' }),
    ];
    expect(dates(planRefit(tasks, [], 'g'), 'g')).toBe('2026-01-01..2026-01-10');
    const empty = [task('e', '2026-01-01', '2026-03-05', { type: 'group' })];
    expect(planRefit(empty, [], 'e').size).toBe(0);
  });

  it('settling a written-back task keeps a link into it (added since): the task is pushed', () => {
    // An undo puts t back on the 1st; since then p -> t (FS) was added, p ending on the 5th.
    const tasks = [task('p', '2026-01-01', '2026-01-05'), task('t', '2026-01-01', '2026-01-03')];
    const changes = planSettle(tasks, [link('p', 't')], [], ['t']);
    expect(dates(changes, 't')).toBe('2026-01-06..2026-01-08');
    expect(dates(changes, 'p')).toBeUndefined();
  });

  it('a loop of links is refused quickly, however big the project', () => {
    const many = Array.from({ length: 2000 }, (_, i) => task(`x${i}`, '2026-01-01', '2026-01-02'));
    const tasks = [
      task('a', '2026-01-01', '2026-01-02'),
      task('b', '2026-01-01', '2026-01-02'),
      ...many,
    ];
    const started = Date.now();
    expect(() => planReschedule(tasks, [link('a', 'b'), link('b', 'a')], ['a'])).toThrow(
      ScheduleError,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a group that shrank keeps a link into it: pushed later with its tasks (FF)', () => {
    // a ends on the 15th; the group must finish no earlier (FF). Its task that ended on the 20th
    // was removed: what is left ends on the 10th, so the group goes 5 days later with its task.
    const tasks = [
      task('a', '2026-01-05', '2026-01-15'),
      task('g', '2026-01-01', '2026-01-20', { type: 'group' }),
      task('c1', '2026-01-01', '2026-01-10', { parentId: 'g' }),
    ];
    const changes = planRefit(tasks, [link('a', 'g', 'FF')], 'g');
    expect(dates(changes, 'g')).toBe('2026-01-06..2026-01-15');
    expect(dates(changes, 'c1')).toBe('2026-01-06..2026-01-15');
  });

  it('stretches every group above, and pushes what follows a stretched group', () => {
    const tasks = [
      task('outer', '2026-01-01', '2026-01-10', { type: 'group' }),
      task('inner', '2026-01-01', '2026-01-10', { type: 'group', parentId: 'outer' }),
      task('k', '2026-01-01', '2026-01-10', { parentId: 'inner' }),
      task('t', '2025-12-20', '2025-12-22', { parentId: 'inner' }),
      task('after', '2026-01-11', '2026-01-12'),
    ];
    const changes = planAttach(tasks, [link('outer', 'after')], 't');
    expect(dates(changes, 'inner')).toBe('2025-12-20..2026-01-10');
    expect(dates(changes, 'outer')).toBe('2025-12-20..2026-01-10');
    expect(changes.has('after')).toBe(false);
    const later = [
      group,
      filler,
      task('t', '2026-01-05', '2026-01-20', { parentId: 'g' }),
      task('after', '2026-01-11', '2026-01-12'),
    ];
    expect(dates(planAttach(later, [link('g', 'after')], 't'), 'after')).toBe(
      '2026-01-21..2026-01-22',
    );
  });

  it('changes nothing when the task already fits', () => {
    const tasks = [group, filler, task('t', '2026-01-02', '2026-01-03', { parentId: 'g' })];
    expect(planAttach(tasks, [], 't').size).toBe(0);
  });

  it('refuses a task that is linked to the group it goes in, or to one above it', () => {
    const tasks = [group, task('t', '2026-03-01', '2026-03-05', { parentId: 'g' })];
    expect(() => planAttach(tasks, [link('g', 't')], 't')).toThrow(/linked to "g"/);
    expect(() => planAttach(tasks, [link('t', 'g')], 't')).toThrow(ScheduleError);
    const nested = [
      task('outer', '2026-01-01', '2026-01-10', { type: 'group' }),
      task('inner', '2026-01-01', '2026-01-10', { type: 'group', parentId: 'outer' }),
      task('t', '2026-01-02', '2026-01-03', { parentId: 'inner' }),
    ];
    expect(() => planAttach(nested, [link('outer', 't')], 't')).toThrow(/Remove the link first/);
  });

  it('refuses it for what is below the task too', () => {
    const tasks = [
      group,
      task('sub', '2026-01-02', '2026-01-08', { type: 'group', parentId: 'g' }),
      task('leaf', '2026-01-03', '2026-01-04', { parentId: 'sub' }),
    ];
    expect(() => planAttach(tasks, [link('g', 'leaf')], 'sub')).toThrow(ScheduleError);
  });
});

describe('a group is the days of its tasks', () => {
  const tasks = [
    task('g', '2026-12-13', '2027-01-13', { type: 'group' }),
    task('q', '2026-12-13', '2027-01-13', { parentId: 'g' }),
    task('w', '2026-12-13', '2027-01-13', { parentId: 'g' }),
  ];

  it('grows when a task is moved out and shrinks when it is moved back', () => {
    const out = planEdit(tasks, [], 'w', '2026-12-30', '2027-01-30');
    expect(dates(out, 'g')).toBe('2026-12-13..2027-01-30');
    // w is out at the 30th and q stayed: the group runs from q's start to w's end.
    const moved = tasks.map((t) => {
      if (t.id === 'w') return { ...t, startDate: '2026-12-30', endDate: '2027-01-30' };
      if (t.id === 'g') return { ...t, endDate: '2027-01-30' };
      return t;
    });
    const back = planEdit(moved, [], 'w', '2026-12-13', '2027-01-13');
    expect(dates(back, 'g')).toBe('2026-12-13..2027-01-13');
  });

  it('shrinks when the task that was widest moves inward', () => {
    const wide = [
      task('g', '2026-12-01', '2027-01-13', { type: 'group' }),
      task('q', '2026-12-13', '2027-01-13', { parentId: 'g' }),
      task('w', '2026-12-01', '2027-01-13', { parentId: 'g' }),
    ];
    expect(dates(planEdit(wide, [], 'w', '2026-12-13', '2027-01-13'), 'g')).toBe(
      '2026-12-13..2027-01-13',
    );
  });

  it('pushing a linked task along (FF) fits the group to both', () => {
    const changes = planEdit(tasks, [link('w', 'q', 'FF')], 'w', '2026-12-30', '2027-01-30');
    expect(dates(changes, 'q')).toBe('2026-12-30..2027-01-30');
    expect(dates(changes, 'g')).toBe('2026-12-30..2027-01-30');
  });
});

describe('a group that stretches keeps its own incoming links', () => {
  // A ends 2026-10-10, so the group (linked after A, finish to start) may not start before the 11th.
  const tasks = [
    task('a', '2026-10-01', '2026-10-10'),
    task('g', '2026-10-11', '2026-10-20', { type: 'group' }),
    task('c', '2026-10-11', '2026-10-15', { parentId: 'g' }),
  ];
  const links = [link('a', 'g')];

  it('refuses to pull a task of the group out to before that day', () => {
    expect(() => planEdit(tasks, links, 'c', '2026-10-05', '2026-10-09')).toThrow(
      /group "g" would have to start before the link from "a"/,
    );
    expect(() => planEdit(tasks, links, 'c', '2026-10-06', '2026-10-10')).toThrow(ScheduleError);
  });

  it('allows what stays inside the group, growing it at the end, and shrinking it', () => {
    // The group is only what its one task covers now.
    expect(dates(planEdit(tasks, links, 'c', '2026-10-12', '2026-10-16'), 'g')).toBe(
      '2026-10-12..2026-10-16',
    );
    expect(dates(planEdit(tasks, links, 'c', '2026-10-18', '2026-10-25'), 'g')).toBe(
      '2026-10-18..2026-10-25',
    );
  });

  it('applies to a task put into the group too', () => {
    const outside = [
      task('a', '2026-10-01', '2026-10-10'),
      task('g', '2026-10-11', '2026-10-20', { type: 'group' }),
      task('t', '2026-10-02', '2026-10-04', { parentId: 'g' }),
    ];
    expect(() => planAttach(outside, [link('a', 'g')], 't')).toThrow(/would have to start before/);
  });
});
