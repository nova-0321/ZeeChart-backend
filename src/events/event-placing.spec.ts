import type { QueryRunner } from 'typeorm';
import { EventsNeverOverlap1793200000000 } from '../database/migrations/1793200000000-EventsNeverOverlap.js';
import { placeEvents, type EventSpan } from './event-placing.js';

// No two events share a day (#84), worked out on plain rows.

const ev = (id: string, startDate: string, endDate: string): EventSpan => ({
  id,
  startDate,
  endDate,
});
/** The new dates by id, for short expectations. */
const datesOf = (moved: EventSpan[]) =>
  Object.fromEntries(moved.map((event) => [event.id, `${event.startDate}..${event.endDate}`]));

describe('placeEvents', () => {
  it('leaves an event on free days where it is', () => {
    expect(
      placeEvents([ev('a', '2026-10-10', '2026-10-20')], [ev('n', '2026-10-21', '2026-10-24')]),
    ).toEqual([]);
    expect(placeEvents([], [ev('n', '2026-10-01', '2026-10-01')])).toEqual([]);
  });

  it('moves a new event after the one it overlaps, keeping its length (the ticket example)', () => {
    const moved = placeEvents(
      [ev('a', '2026-10-10', '2026-10-20')],
      [ev('n', '2026-10-15', '2026-10-18')],
    );
    expect(datesOf(moved)).toEqual({ n: '2026-10-21..2026-10-24' });
  });

  it('counts start and end days: touching on one day is a clash, the next day is free', () => {
    const fixed = [ev('a', '2026-10-10', '2026-10-20')];
    expect(datesOf(placeEvents(fixed, [ev('n', '2026-10-20', '2026-10-22')]))).toEqual({
      n: '2026-10-21..2026-10-23',
    });
    expect(datesOf(placeEvents(fixed, [ev('n', '2026-10-01', '2026-10-10')]))).toEqual({
      n: '2026-10-21..2026-10-30',
    });
    expect(placeEvents(fixed, [ev('n', '2026-10-21', '2026-10-22')])).toEqual([]);
    expect(placeEvents(fixed, [ev('n', '2026-10-05', '2026-10-09')])).toEqual([]);
  });

  it('moves on past several events until it is free', () => {
    const fixed = [
      ev('a', '2026-10-10', '2026-10-20'),
      ev('b', '2026-10-22', '2026-10-25'),
      ev('c', '2026-10-27', '2026-10-27'),
    ];
    // After a (21–24) it hits b, after b (26–29) it hits c, after c it is free.
    expect(datesOf(placeEvents(fixed, [ev('n', '2026-10-15', '2026-10-18')]))).toEqual({
      n: '2026-10-28..2026-10-31',
    });
    // A one-day gap fits a one-day event.
    expect(datesOf(placeEvents(fixed, [ev('n', '2026-10-12', '2026-10-12')]))).toEqual({
      n: '2026-10-21..2026-10-21',
    });
  });

  it('pushes the events a moved one now overlaps, and those after them (cascade)', () => {
    // e was moved onto Oct 8–12: d overlaps it, then f overlaps the pushed d, then g overlaps f.
    const moved = placeEvents(
      [ev('e', '2026-10-08', '2026-10-12')],
      [
        ev('d', '2026-10-10', '2026-10-14'),
        ev('f', '2026-10-16', '2026-10-17'),
        ev('g', '2026-10-19', '2026-10-30'),
        ev('h', '2026-11-20', '2026-11-21'),
        ev('early', '2026-10-01', '2026-10-07'),
      ],
    );
    expect(datesOf(moved)).toEqual({
      d: '2026-10-13..2026-10-17',
      f: '2026-10-18..2026-10-19',
      g: '2026-10-20..2026-10-31',
    });
  });

  it('pushes an event that starts before the moved one but overlaps it', () => {
    // d (Oct 10–20) is resized into by e (Oct 12–14): d starts the day after e ends.
    const moved = placeEvents(
      [ev('e', '2026-10-12', '2026-10-14')],
      [ev('d', '2026-10-10', '2026-10-20')],
    );
    expect(datesOf(moved)).toEqual({ d: '2026-10-15..2026-10-25' });
  });

  it('carries a long cascade across months and a year end', () => {
    const chain = Array.from({ length: 40 }, (_, i) => ev(`e${i}`, '2026-12-30', '2026-12-31'));
    const moved = placeEvents([], chain);
    expect(moved).toHaveLength(39);
    expect(moved.at(-1)).toEqual(ev('e39', '2027-03-18', '2027-03-19'));
  });

  it('places events on the same start in the given order', () => {
    const moved = placeEvents(
      [],
      [ev('first', '2026-10-01', '2026-10-02'), ev('second', '2026-10-01', '2026-10-01')],
    );
    expect(datesOf(moved)).toEqual({ second: '2026-10-03..2026-10-03' });
  });

  // Checked against the plainest version of the rule, and against the migration, on random data.
  describe('on random projects', () => {
    let seed = 84;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const DAY = 86_400_000;
    const date = (day: number) =>
      new Date(Date.UTC(2026, 0, 1) + day * DAY).toISOString().slice(0, 10);
    const day = (value: string) => (Date.parse(`${value}T00:00:00Z`) - Date.UTC(2026, 0, 1)) / DAY;
    const randomEvents = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) => {
        const start = random(60);
        return ev(`${prefix}${i}`, date(start), date(start + random(8)));
      });
    const overlaps = (a: EventSpan, b: EventSpan) =>
      a.startDate <= b.endDate && b.startDate <= a.endDate;

    /** Step one day at a time until free: slow, but plainly right. */
    const plain = (fixed: EventSpan[], movable: EventSpan[]) => {
      const placed = [...fixed];
      const result = new Map<string, EventSpan>();
      const order = movable
        .map((e, i) => ({ e, i }))
        .sort((a, b) => a.e.startDate.localeCompare(b.e.startDate) || a.i - b.i);
      for (const { e } of order) {
        const length = day(e.endDate) - day(e.startDate);
        let start = day(e.startDate);
        const at = () => ev(e.id, date(start), date(start + length));
        while (placed.some((other) => overlaps(other, at()))) start += 1;
        placed.push(at());
        result.set(e.id, at());
      }
      return result;
    };

    it('ends where stepping a day at a time ends, with no two sharing a day', () => {
      for (let run = 0; run < 300; run++) {
        const fixed = randomEvents(random(3), 'f');
        const movable = randomEvents(random(10), 'm');
        const expected = plain(fixed, movable);
        const moved = new Map(placeEvents(fixed, movable).map((event) => [event.id, event]));
        const final = movable.map((event) => moved.get(event.id) ?? event);
        expect(final).toEqual(movable.map((event) => expected.get(event.id)));
        // Lengths kept, never earlier, and no movable event shares a day with any other.
        for (const [index, event] of final.entries()) {
          const was = movable[index]!;
          expect(day(event.endDate) - day(event.startDate)).toBe(
            day(was.endDate) - day(was.startDate),
          );
          expect(event.startDate >= was.startDate).toBe(true);
          for (const other of [...fixed, ...final.slice(index + 1)]) {
            expect(overlaps(event, other)).toBe(false);
          }
        }
      }
    });

    it('lines up as the migration does (nothing fixed)', async () => {
      for (let run = 0; run < 100; run++) {
        const events = randomEvents(1 + random(10), 'm');
        const sorted = [...events].sort((a, b) => a.startDate.localeCompare(b.startDate));
        let written: unknown[] = [[], [], []];
        const runner = {
          query: (sql: string, parameters?: unknown[]) => {
            if (sql.trimStart().startsWith('SELECT')) {
              return Promise.resolve(sorted.map((event) => ({ ...event, projectId: 'p' })));
            }
            written = parameters!;
            return Promise.resolve([]);
          },
        } as unknown as QueryRunner;
        await new EventsNeverOverlap1793200000000().up(runner);
        const fromMigration = (written[0] as string[]).map((id, i) =>
          ev(id, (written[1] as string[])[i]!, (written[2] as string[])[i]!),
        );
        expect(fromMigration).toEqual(placeEvents([], sorted));
      }
    });
  });
});
