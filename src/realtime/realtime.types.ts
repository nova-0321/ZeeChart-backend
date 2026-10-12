import { isUUID } from 'class-validator';

// The contract of the live connection (also in docs/realtime.md). The frontend relies on it.

/** What changed. */
export type RealtimeEntity =
  'project' | 'task' | 'dependency' | 'event' | 'member' | 'invitation' | 'revision' | 'version';

/**
 * How it changed. `resync`: a request failed part-way (5xx) and may have saved some of its work,
 * so whoever has the project open should load it again.
 */
export type RealtimeAction = 'create' | 'update' | 'delete' | 'resync';

/**
 * Sent to everyone with the project open, after the change is saved. Deliberately small: it only
 * says "go and fetch again"; the data itself always comes from the REST API.
 */
export interface ChangeMessage {
  projectId: string;
  entity: RealtimeEntity;
  action: RealtimeAction;
  /** The row the request was about (absent for `resync`). */
  id?: string;
}

/** The socket.io event name of a ChangeMessage. */
export const CHANGED_EVENT = 'changed';

/**
 * Each browser tab makes a random id (a UUID) and sends it when it connects
 * (`io(url, { auth: { clientId } })`) and on every API request in this header. A change is not
 * sent back to the tab that made it.
 */
export const CLIENT_ID_HEADER = 'x-client-id';

/** The client id if `value` is one (a UUID), otherwise undefined: junk is ignored, not trusted. */
export const clientIdFrom = (value: unknown): string | undefined =>
  typeof value === 'string' && isUUID(value) ? value.toLowerCase() : undefined;

/** One tab that has a project open, and who is signed in there. */
export interface PresenceMember {
  /** The tab's client id, or `guest:<socket id>` for a tab without one. */
  id: string;
  userId: string;
  /** The person's name (as when they connected). */
  name: string;
}

/**
 * Who has a project open, sent to its room whenever that changes (someone joins, leaves or
 * disconnects). One entry per tab (a tab connected twice counts once; one person in two tabs is two
 * entries), in the order they joined.
 */
export interface PresenceMessage {
  projectId: string;
  members: PresenceMember[];
}

/** The socket.io event name of a PresenceMessage. */
export const PRESENCE_EVENT = 'presence';

/**
 * What the pointer is over, so another screen (another size, zoom, scroll, folded groups) shows it
 * over the same thing, not just at the same place of the layout:
 * - `t`: the chart's timeline: a day (and how far into it) and a row (a task id, or the chart's own
 *   row ids for the Events row and the empty rows; null over the dates header, then `ry` is how far
 *   down the header);
 * - `l`: the chart's task list: a row, and how far across the list;
 * - `e`: an element of the page marked with a key (a card, a task in the task board), and where
 *   in it.
 * All fractions are 0..1. The server only checks the shape and passes it on.
 */
export type CursorAnchor =
  | { k: 't'; day: string; dx: number; row: string | null; ry: number }
  | { k: 'l'; fx: number; row: string; ry: number }
  | { k: 'e'; key: string; fx: number; fy: number };

/**
 * Where a tab's pointer is on the board (sent as `cursor` by the tab, about 20 times a second at
 * most). `x` and `y` are fractions (0..1) of the board area's width and height: the fallback when
 * `at` (what it is over) can't be found on the other screen; null: the pointer left the board. The
 * server adds who it is and passes it to the others in the tab's project room (never back to the
 * sender).
 */
export interface CursorInput {
  x: number | null;
  y: number | null;
  at?: CursorAnchor;
}

export interface CursorMessage {
  projectId: string;
  /** The tab (as in the presence list). */
  id: string;
  userId: string;
  name: string;
  /** null: hidden. */
  x: number | null;
  y: number | null;
  /** What it is over (absent: only x and y are known). */
  at?: CursorAnchor;
}

/** The socket.io event name of a cursor, both ways. */
export const CURSOR_EVENT = 'cursor';
