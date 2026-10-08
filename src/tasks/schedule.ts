// The scheduling rules of task dependencies, as plain functions on in-memory data so they can be
// tested without a database. Days are whole days; an end date is the last day of the task, so a
// one-day task has start === end.
//
// A link `from -> to` of a type and a lag (in days, negative = a lead that lets them overlap)
// says where the successor must be at the earliest:
//   FS  to.start >= from.end + 1 + lag     starts after the predecessor finishes
//   SS  to.start >= from.start + lag       starts after the predecessor starts
//   FF  to.end   >= from.end + lag         finishes after the predecessor finishes
//   SF  to.end   >= from.start + lag       finishes after the predecessor starts
// Moving a predecessor later pushes its successors later (never earlier). A task is always moved
// as a whole, so its length never changes and its end can never fall before its start.

export interface ScheduleTask {
  id: string;
  name: string;
  parentId: string | null;
  type: string;
  startDate: string;
  endDate: string;
}

export interface ScheduleLink {
  id?: string;
  fromTaskId: string;
  toTaskId: string;
  type: string;
  lagDays: number;
}

export interface DatedChange {
  startDate: string;
  endDate: string;
}

/** The edit is not allowed; the message is shown to the user. */
export class ScheduleError extends Error {}

const DAY = 86_400_000;
const toDay = (date: string) => Math.round(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY);
const fromDay = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

interface Span {
  s: number;
  e: number;
}

const LABELS: Record<string, string> = {
  FS: 'finish to start',
  SS: 'start to start',
  FF: 'finish to finish',
  SF: 'start to finish',
};

/** The earliest start (FS, SS) or end (FF, SF) the successor may have. */
function bound(link: ScheduleLink, from: Span): number {
  switch (link.type) {
    case 'SS':
      return from.s + link.lagDays;
    case 'FF':
      return from.e + link.lagDays;
    case 'SF':
      return from.s + link.lagDays;
    default:
      return from.e + 1 + link.lagDays;
  }
}

const constrainsEnd = (link: ScheduleLink) => link.type === 'FF' || link.type === 'SF';

/** How many days later than now the successor has to be (0 or less: it is fine where it is). */
function shortfall(link: ScheduleLink, from: Span, to: Span): number {
  return bound(link, from) - (constrainsEnd(link) ? to.e : to.s);
}

/** Whether the dates of the two tasks break the link. */
export function isBroken(
  link: Pick<ScheduleLink, 'type' | 'lagDays'>,
  from: DatedChange,
  to: DatedChange,
): boolean {
  const span = (task: DatedChange) => ({ s: toDay(task.startDate), e: toDay(task.endDate) });
  return shortfall({ ...link, fromTaskId: '', toTaskId: '' }, span(from), span(to)) > 0;
}

class Network {
  private readonly spans = new Map<string, Span>();
  private readonly original = new Map<string, Span>();
  private readonly tasks = new Map<string, ScheduleTask>();
  private readonly children = new Map<string, string[]>();
  private readonly outgoing = new Map<string, ScheduleLink[]>();
  private readonly incoming = new Map<string, ScheduleLink[]>();
  private queue: string[] = [];

  constructor(tasks: ScheduleTask[], links: ScheduleLink[]) {
    for (const task of tasks) {
      const span = { s: toDay(task.startDate), e: toDay(task.endDate) };
      this.spans.set(task.id, span);
      this.original.set(task.id, { ...span });
      this.tasks.set(task.id, task);
      if (task.parentId) {
        this.children.set(task.parentId, [...(this.children.get(task.parentId) ?? []), task.id]);
      }
    }
    for (const link of links) {
      if (!this.spans.has(link.fromTaskId) || !this.spans.has(link.toTaskId)) continue;
      this.outgoing.set(link.fromTaskId, [...(this.outgoing.get(link.fromTaskId) ?? []), link]);
      this.incoming.set(link.toTaskId, [...(this.incoming.get(link.toTaskId) ?? []), link]);
    }
  }

  span(id: string): Span {
    const span = this.spans.get(id);
    if (!span) throw new ScheduleError('Task not found');
    return span;
  }

  name(id: string) {
    return this.tasks.get(id)?.name ?? 'another task';
  }

  type(id: string) {
    return this.tasks.get(id)?.type;
  }

  incomingOf(id: string) {
    return this.incoming.get(id) ?? [];
  }

  /** The task and everything below it. */
  block(id: string): string[] {
    const ids = [id];
    for (let i = 0; i < ids.length; i++) ids.push(...(this.children.get(ids[i]!) ?? []));
    return ids;
  }

  shift(ids: string[], days: number) {
    for (const id of ids) {
      const span = this.span(id);
      span.s += days;
      span.e += days;
      this.queue.push(id);
    }
  }

  enqueue(id: string) {
    this.span(id);
    this.queue.push(id);
  }

  setSpan(id: string, s: number, e: number) {
    const span = this.span(id);
    span.s = s;
    span.e = e;
    this.queue.push(id);
  }

  /** A group has to cover its tasks: stretch the groups above a task that left their range. */
  stretchAncestors(id: string) {
    let child = this.tasks.get(id);
    while (child?.parentId) {
      const parent = this.span(child.parentId);
      const span = this.span(child.id);
      if (span.s < parent.s || span.e > parent.e) {
        parent.s = Math.min(parent.s, span.s);
        parent.e = Math.max(parent.e, span.e);
        this.queue.push(child.parentId);
      }
      child = this.tasks.get(child.parentId);
    }
  }

  /** Push every successor of the queued tasks later until all links hold. */
  settle() {
    for (let guard = 0; this.queue.length > 0; guard++) {
      if (guard > 5_000) {
        throw new ScheduleError(
          'These links cannot all be kept: the tasks would keep pushing each other later.',
        );
      }
      const id = this.queue.pop()!;
      for (const link of this.outgoing.get(id) ?? []) {
        const days = shortfall(link, this.span(id), this.span(link.toTaskId));
        if (days > 0) {
          const moved = this.block(link.toTaskId);
          this.shift(moved, days);
          this.stretchAncestors(link.toTaskId);
        }
      }
    }
  }

  changes(always?: string): Map<string, DatedChange> {
    const result = new Map<string, DatedChange>();
    for (const [id, span] of this.spans) {
      const before = this.original.get(id)!;
      if (id === always || span.s !== before.s || span.e !== before.e) {
        result.set(id, { startDate: fromDay(span.s), endDate: fromDay(span.e) });
      }
    }
    return result;
  }
}

/**
 * The tasks that have to move after a link was added or changed (or dates were imported): the
 * successors of `seeds`, and theirs in turn.
 */
export function planReschedule(
  tasks: ScheduleTask[],
  links: ScheduleLink[],
  seeds: string[],
): Map<string, DatedChange> {
  const network = new Network(tasks, links);
  seeds.forEach((id) => network.enqueue(id));
  network.settle();
  return network.changes();
}

/**
 * What changes when a task gets new dates.
 * - Same length (a move): the task goes with everything below it, but not before its
 *   predecessors allow: it stops at the earliest day that keeps every link.
 * - Another length (a resize): refused if it breaks a link into the task, since the task cannot
 *   be moved to make room without changing what the user asked for.
 * Then the groups above are stretched and the successors pushed. The returned map includes the
 * edited task itself.
 */
export function planEdit(
  tasks: ScheduleTask[],
  links: ScheduleLink[],
  id: string,
  newStart: string,
  newEnd: string,
): Map<string, DatedChange> {
  const network = new Network(tasks, links);
  const start = toDay(newStart);
  const end = toDay(newEnd);
  const span = network.span(id);

  if (end < start) {
    throw new ScheduleError('The end date must not be before the start date');
  }

  if (end - start === span.e - span.s) {
    const members = network.block(id);
    const inside = new Set(members);
    network.shift(members, start - span.s);
    // Links from outside the moved block may now be broken: move later, as little as needed.
    let needed = 0;
    for (const member of members) {
      for (const link of network.incomingOf(member)) {
        if (inside.has(link.fromTaskId)) continue;
        needed = Math.max(
          needed,
          shortfall(link, network.span(link.fromTaskId), network.span(member)),
        );
      }
    }
    if (needed > 0) network.shift(members, needed);
    network.stretchAncestors(id);
  } else {
    network.setSpan(id, start, end);
    if (network.type(id) !== 'group') {
      for (const link of network.incomingOf(id)) {
        if (shortfall(link, network.span(link.fromTaskId), network.span(id)) > 0) {
          const day = fromDay(bound(link, network.span(link.fromTaskId)));
          const lag =
            link.lagDays === 0
              ? ''
              : `, ${link.lagDays > 0 ? `${link.lagDays} day lag` : `${-link.lagDays} day lead`}`;
          throw new ScheduleError(
            `Can't use these dates: the link from "${network.name(link.fromTaskId)}" (${LABELS[link.type] ?? link.type}${lag}) needs this task's ${constrainsEnd(link) ? 'end' : 'start'} on or after ${day}.`,
          );
        }
      }
    }
    network.stretchAncestors(id);
  }
  network.settle();
  // The edited task is always in the result, even when it ended up where it started: the
  // caller holds the dates that were asked for and has to replace them.
  return network.changes(id);
}
