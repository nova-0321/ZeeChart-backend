// A group's progress is not typed in: it is the average of its tasks (#80), the way its dates are
// the span of its tasks (schedule.ts). Worked out here from the project's rows as they are, with
// no database, so it can be tested on plain data; task-rows.ts fitGroupProgress() saves it, inside
// every write (RevisionInterceptor), so it is never stale.
//
// - The plain mean of the group's direct tasks, each counting the same. A group inside it counts
//   with its own average (worked out first).
// - Milestones are left out: they have no progress of their own (none shows on screen).
// - A group with nothing to count (no tasks, or only milestones) is 0%.
// - Rounded to a whole percent, as progress is stored.

/** A task as this needs it. */
export interface ProgressRow {
  id: string;
  parentId: string | null;
  type: string;
  progress: number;
}

/** What every group's progress should be, by id. */
export function groupProgress(rows: readonly ProgressRow[]): Map<string, number> {
  const childrenOf = new Map<string, ProgressRow[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const siblings = childrenOf.get(row.parentId);
    if (siblings) siblings.push(row);
    else childrenOf.set(row.parentId, [row]);
  }

  const result = new Map<string, number>();
  // Groups being worked out right now: one met again is a loop in old data (a group inside
  // itself, see group-loop.ts). It counts as 0 there, so the walk always ends.
  const visiting = new Set<string>();
  const progressOf = (group: ProgressRow): number => {
    const known = result.get(group.id);
    if (known !== undefined) return known;
    if (visiting.has(group.id)) return 0;
    visiting.add(group.id);
    const counted = (childrenOf.get(group.id) ?? []).filter((child) => child.type !== 'milestone');
    const values = counted.map((child) =>
      child.type === 'group' ? progressOf(child) : child.progress,
    );
    const average =
      values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
    visiting.delete(group.id);
    const rounded = Math.round(average);
    result.set(group.id, rounded);
    return rounded;
  };

  for (const row of rows) if (row.type === 'group') progressOf(row);
  return result;
}

/** The groups whose stored progress is not their average yet, with the value they should have. */
export function progressChanges(rows: readonly ProgressRow[]): { id: string; progress: number }[] {
  const stored = new Map(rows.map((row) => [row.id, row.progress]));
  return [...groupProgress(rows)]
    .filter(([id, progress]) => stored.get(id) !== progress)
    .map(([id, progress]) => ({ id, progress }));
}

/** What a request that sets a group's progress is told. */
export const GROUP_PROGRESS_IS_COMPUTED =
  "A group's progress is the average of its tasks: change the progress of its tasks instead";
