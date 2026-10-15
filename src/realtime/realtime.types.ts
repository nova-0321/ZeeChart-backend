import { isUUID } from 'class-validator';

// The contract of the live connection (also in docs/realtime.md). The frontend relies on it.

/** What changed. */
export type RealtimeEntity =
  'project' | 'task' | 'dependency' | 'event' | 'member' | 'invitation' | 'revision' | 'version';

/**
 * How it changed. `resync`: a request failed (5xx); a member change may have saved part of its work
 * (a write to the project's content is one transaction and saved nothing), so whoever has the
 * project open should load it again.
 */
export type RealtimeAction = 'create' | 'update' | 'delete' | 'resync';

/** The rows of one kind a write changed: each as the REST API returns it, and the ids it deleted. */
export interface RowChange<Row = object> {
  upsert: Row[];
  delete: string[];
}

/** The project's own fields after a write (a member's role in it is not here: it is per person). */
export interface ProjectFields {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
  version: number;
}

/**
 * Every row a write changed (#75): the row it was about and the ones it moved with it (linked
 * tasks pushed, a group stretched, siblings renumbered). A kind it didn't change is absent, so
 * `{}` is a write that changed no row (a version saved). Not sent over MAX_CHANGED_ROWS rows, nor
 * for a restore: then whoever needs the project loads it again.
 */
export interface RowChanges {
  tasks?: RowChange;
  dependencies?: RowChange;
  events?: RowChange;
  project?: ProjectFields;
}

/** A request whose rows changes were worked out (by RevisionInterceptor, inside the broadcast). */
export interface ChangedRowsRequest {
  changedRows?: RowChanges;
}

/** Above this many rows changed, a change carries none (loading the project is cheaper then). */
export const MAX_CHANGED_ROWS = 200;

/**
 * Sent to everyone with the project open, after the change is saved. With `changes`, it is all a
 * tab needs to show the project as it is now; without, it says "go and fetch again" (the REST API).
 */
export interface ChangeMessage {
  projectId: string;
  entity: RealtimeEntity;
  action: RealtimeAction;
  /** The row the request was about (absent for `resync`). */
  id?: string;
  /** The rows the write changed (see RowChanges; absent: load again). */
  changes?: RowChanges;
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
