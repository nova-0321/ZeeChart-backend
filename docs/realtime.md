# Realtime project sync

When a change is saved, everyone else who has that project open is told right away, so they can
load it again. The message only says _what_ changed. The data always comes from the REST API.

Source: `src/realtime/`. Issues: #28, #18 (sign-in and members).

## Connecting

socket.io 4, on the same host and port as the API. Allowed origins are the same as the API
(`CORS_ORIGIN`).

```ts
import { io } from 'socket.io-client';

const clientId = crypto.randomUUID(); // once per browser tab
const socket = io(import.meta.env.VITE_API_BASE_URL, { auth: { token, clientId } });
```

`token` is the sign-in token (the one sent as `Authorization: Bearer`). Without a valid one the
connection is refused: `connect_error` with the same message the API gives for a 401 (`Sign in
first`, or `Your session has ended. Sign in again`). A new token (after signing in again) needs a
new connection.

Send the same id on **every** API request, in the `X-Client-Id` header. The server then knows which
tab made a change and doesn't send it back to that tab. The id must be a UUID. Without it, or with
anything else, the tab still connects, but it gets its own changes back too.

## Rooms

A socket is in at most one project's room at a time.

| Send                    | Answer (acknowledgement)                                                |
| ----------------------- | ----------------------------------------------------------------------- |
| `join`, `{ projectId }` | `{ ok: true }`, or `{ ok: false, error }` for a malformed or unknown id |

Only a member of the project (any role) can join its room. To anyone else it answers as for an
unknown id.
| `leave` | `{ ok: true }` |

Every socket is also in its user's own room, which hears about that person's memberships (below).
Joining another project leaves the previous one. A refused join keeps the room the socket was in.
After a reconnect the socket is in no room: join again.

```ts
const answer = await socket.emitWithAck('join', { projectId });
```

## The message

One event, `changed`:

```ts
interface ChangeMessage {
  projectId: string;
  entity: 'project' | 'task' | 'dependency' | 'event' | 'member';
  action: 'create' | 'update' | 'delete' | 'resync';
  id?: string; // the row the request was about; absent for resync
}
```

| Routes                                                        | Message                                                                                 |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `POST /tasks`                                                 | `task` `create`, the new task's id                                                      |
| `PATCH /tasks/:id`, `/:id/parent`, `/:id/move`, `/:id/type`   | `task` `update`                                                                         |
| `DELETE /tasks/:id`                                           | `task` `delete`                                                                         |
| `POST`, `PATCH`, `DELETE /dependencies`                       | `dependency` `create` / `update` / `delete`                                             |
| `POST`, `PATCH`, `DELETE /events`                             | `event` `create` / `update` / `delete`                                                  |
| `PATCH /projects/:id`, `/:id/archive`, `/:id/reopen`          | `project` `update`                                                                      |
| `DELETE /projects/:id`                                        | `project` `delete` (whoever has it open should move off it)                             |
| `POST /projects/:id/members`, `PATCH` / `DELETE /members/:id` | `member` `create` / `update` / `delete`, the member's id                                |
| `POST /projects`                                              | nothing: only the owner changes the project list, and no one is in a new project's room |

### Your own memberships

The person a member change is about also gets it in **every** tab, whatever project it has open
(their user's room), with the same message: `member` `create` when they are added (they are
not in the project's room yet), `update` when their role changes, `delete` when they are
removed. On removal their tabs leave the project's room at once and hear nothing more about it.

## Presence: who has the project open

A second event, `presence`, goes to a project's room whenever the list changes: someone joins
(the room they left is told too), leaves, or disconnects.

```ts
interface PresenceMessage {
  projectId: string;
  members: { id: string; userId: string; name: string }[]; // one per tab, in the order they joined
}
```

`id` is the tab's client id, or `guest:<socket id>` for a tab that connected without one; `userId`
and `name` say who is signed in there. A tab connected twice (with the same client id) counts once;
one person in two tabs is two entries.

## Cursors: where the others are pointing

A tab in a project room sends its pointer as `cursor`, `{ x, y }`: fractions (0 to 1) of the board
area's width and height, or `{ x: null, y: null }` when the pointer leaves it. The others in the room
get:

```ts
interface CursorMessage {
  projectId: string;
  id: string; // the tab, as in the presence list
  userId: string;
  name: string;
  x: number | null; // null: hidden
  y: number | null;
}
```

Never sent back to the sender, nor outside the room. The server adds who it is (a tab can't send
someone else's name), drops malformed ones and more than one every 30 ms per tab (a hide always goes
through), and sends them volatile: under load a cursor is dropped, the next one replaces it. A tab
that leaves the room disappears from the presence list: clients drop its cursor then.

## Rules the server keeps

- **After the save only.** The message goes out when the whole request has succeeded, so every
  transaction in it has committed.
- **One message per request.** A request can save many rows: a date edit can refit groups and
  push linked tasks. It is still one message, about the row the request was about. Reload the whole
  list (tasks and links together), not that one row.
- **Refused requests (4xx) send nothing.** They saved nothing.
- **Failures (5xx) send `resync`.** A request that failed part-way may have saved some of its work,
  so reload the project.
- **Never sent to the tab that made the change**, if it sent `X-Client-Id`.
- **Sending never fails or slows a request.** Messages go out after the answer.

## What the client should do

- `task` or `dependency`: reload the tasks and links of the project.
- `event`: reload the events.
- `project` `update`: reload the project (name, archived).
- `project` `delete`: leave it, and show another project.
- `resync`: reload everything of the project.
- `member`: reload the members. When it is about you (or a project you don't have open), reload
  your project list too: your role in it, or the project itself, changed. Removed from the project
  you have open: leave it, and show another project.
- After a reconnect, join again and reload once: messages sent while disconnected are lost.
- Several messages close together can share one reload.

## Adding a write route

Every `POST` / `PUT` / `PATCH` / `DELETE` route needs `@Broadcast(...)` (what it changes, and how
to find its project) or `@NoBroadcast(reason)`. `broadcast.coverage.spec.ts` fails otherwise, and
also when the number of write routes changes, so the list above gets updated too.

```ts
@Patch(':id')
@Broadcast({ entity: 'task', action: 'update', project: projectOfRow(Task) })
update(...) {}
```

Ways to find the project: `projectInBody('projectId')`, `projectInParam('id')`, and
`projectOfRow(Entity, key?, 'param' | 'body')`. The last one looks up the row's `projectId` before
the handler runs, so a delete still knows its project.

## Limits

- **The token is checked when connecting only.** A tab keeps its connection after the token
  expires, until it disconnects; it can't join a project it is not a member of.
- **One server instance.** Rooms live in memory. Running several instances needs socket.io's Redis
  adapter.
- **No conflict detection.** Two people saving the same task: the last save wins. Version checks
  are #21.
