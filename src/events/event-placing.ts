// No two events of a project share a day (#84): the client wants one event per period. Worked out
// here on plain rows, with no database, so it can be tested on its own; event-rows.ts
// lineUpEvents() and EventsService save it, inside the write (under the project lock, so two
// writes at once can't both take the same days).
//
// - Some events keep their dates (`fixed`): the one being moved or resized, or the events already
//   there when one is created. The others (`movable`) go after them.
// - A movable event that shares a day with one placed before it starts the day after that one
//   ends, keeping its length, and again until it is free. Start and end days both count.
// - Movable events are placed in start order (the given order on a tie), so a push carries on to
//   the events after it.
// - Events only ever move later, so this always ends.

/** An event's days ("YYYY-MM-DD", end included). */
export interface EventSpan {
  id: string;
  startDate: string;
  endDate: string;
}

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

interface Taken {
  start: number;
  end: number;
}

/** The movable events that had to move, with their new dates (none when all were free). */
export function placeEvents(
  fixed: readonly EventSpan[],
  movable: readonly EventSpan[],
): EventSpan[] {
  // The days taken so far, in start order.
  const taken: Taken[] = fixed
    .map((event) => ({ start: dayNumber(event.startDate), end: dayNumber(event.endDate) }))
    .sort((a, b) => a.start - b.start);
  const take = (span: Taken) => {
    const at = taken.findIndex((other) => other.start > span.start);
    taken.splice(at === -1 ? taken.length : at, 0, span);
  };

  const inOrder = movable
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.startDate.localeCompare(b.event.startDate) || a.index - b.index);

  const moved: EventSpan[] = [];
  for (const { event } of inOrder) {
    const was = dayNumber(event.startDate);
    const length = dayNumber(event.endDate) - was;
    let start = was;
    // One pass in start order: after a move past one, only the ones starting later can be in the
    // way (one that starts earlier and ends later was already passed, or the event ended before it).
    for (const other of taken) {
      if (other.start <= start + length && start <= other.end) start = other.end + 1;
    }
    take({ start, end: start + length });
    if (start !== was) {
      moved.push({ ...event, startDate: dateOf(start), endDate: dateOf(start + length) });
    }
  }
  return moved;
}
