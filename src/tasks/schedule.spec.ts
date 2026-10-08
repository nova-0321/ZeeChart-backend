import {
  isBroken,
  planEdit,
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
