import { isUUID } from 'class-validator';

// The contract of the live connection (also in docs/realtime.md). The frontend relies on it.

/** What changed. */
export type RealtimeEntity = 'project' | 'task' | 'dependency' | 'event';

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

/**
 * Who has a project open, sent to its room whenever that changes (someone joins, leaves or
 * disconnects). A member is a tab's client id, or `guest:<socket id>` for a tab without one. A tab
 * open twice counts once. In the order they joined. No sign-in yet, so ids are all there is.
 */
export interface PresenceMessage {
  projectId: string;
  members: string[];
}

/** The socket.io event name of a PresenceMessage. */
export const PRESENCE_EVENT = 'presence';
