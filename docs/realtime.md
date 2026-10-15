# Realtime project sync

When a change is saved, everyone else who has that project open is told right away. The message
says _what_ changed and, when it can, carries the rows the change wrote (`changes`), so they show
them without loading the project again. Without `changes`, they load it again from the REST API.

Source: `src/realtime/`. Issues: #28, #18 (sign-in and members), #75 (the changed rows).

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
  entity:
    'project' | 'task' | 'dependency' | 'event' | 'member' | 'invitation' | 'revision' | 'version';
  action: 'create' | 'update' | 'delete' | 'resync';
  id?: string; // the row the request was about; absent for resync
  changes?: RowChanges; // the rows it changed (below); absent: load again
}
```

| Routes                                                                                    | Message                                                                                                          |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `POST /tasks`                                                                             | `task` `create`, the new task's id                                                                               |
| `PATCH /tasks/:id`, `/:id/move`, `/:id/type`                                              | `task` `update`                                                                                                  |
| `DELETE /tasks/:id`                                                                       | `task` `delete`                                                                                                  |
| `POST`, `PATCH`, `DELETE /dependencies`                                                   | `dependency` `create` / `update` / `delete`                                                                      |
| `POST`, `PATCH`, `DELETE /events`                                                         | `event` `create` / `update` / `delete`                                                                           |
| `PATCH /projects/:id` (name, description, archived)                                       | `project` `update`                                                                                               |
| `DELETE /projects/:id`                                                                    | `project` `delete` (whoever has it open should move off it)                                                      |
| `POST /projects/:id/members`, `PATCH` / `DELETE /members/:id`                             | `member` `create` / `update` / `delete`, the member's id                                                         |
| `POST /projects/:id/invitations`, `POST /invitations/:id/link`, `DELETE /invitations/:id` | `invitation` `create` / `update` / `delete` (an invite of someone with an account adds them: reload members too) |
| `POST /invites/accept` (an invite link taken up)                                          | `member` `create`, the new member's id, and `invitation` `delete`, the invitation's id                           |
| `POST /revisions/:id/restore`                                                             | `revision` `update`, the revision's id (a task, an event or the project changed)                                 |
| `POST /projects/:id/versions`, `PATCH /versions/:id`, `POST /versions/:id/restore`        | `version` `create` / `update` (a restore changes the whole project)                                              |
| `POST /projects`                                                                          | nothing: only the owner changes the project list, and no one is in a new project's room                          |

### The changed rows

A write to a project's tasks, links, events or settings may change more rows than the one it is
about: a date edit stretches the groups around the task and pushes the tasks linked after it, a
move numbers the other tasks of its level again, a deleted task takes its links with it. `changes`
has all of them, read after the write (so with their new `version`):

```ts
interface RowChanges {
  tasks?: { upsert: Task[]; delete: string[] }; // as GET /tasks returns them
  dependencies?: { upsert: TaskDependency[]; delete: string[] }; // as GET /dependencies
  events?: { upsert: ProjectEvent[]; delete: string[] }; // as GET /events
  project?: {
    id: string;
    name: string;
    description: string | null;
    archived: boolean;
    version: number;
  };
}
```

- A kind the write didn't change is absent, so `{}` is a write that changed no row (a version
  saved or starred).
- `project` is only the project's own fields: your role in it is not in it (it is per person).
- **No `changes`** (load the project again, as before #75): over 200 rows changed
  (`MAX_CHANGED_ROWS`), a restore (`POST /versions/:id/restore`, `POST /revisions/:id/restore`),
  `resync`, a project deleted, and member and invitation messages.
- **The tab that made the change** isn't sent the message. The answer of `POST` / `PATCH /tasks`
  (and `/:id/move`, `/:id/type`), `POST` / `PATCH /dependencies` and `POST` /
  `PATCH /events` carries the same `changes` (the row it answers with is in it too). A delete
  answers 204 with no body: after its own delete, a tab loads the project again.
- Writes to one project are made one after another (ProjectWriteLock), and their messages leave in
  that order as a rule (each after its own answer). A row's `version` only goes up, so a row older
  than the one shown can be ignored, should two ever arrive the other way round; a
  task only numbered again keeps its version (the history doesn't count that as a change of its
  own), so take a row whose version is the same as the one shown.
- The lists are sorted as the REST API sorts them (tasks by `order`, then `createdAt`, then `id`;
  links by `createdAt`; events by `startDate`, then `createdAt`): sort again after applying rows.

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

A tab in a project room sends its pointer as `cursor`, `{ x, y, at? }`, or `{ x: null, y: null }`
when the pointer leaves the board. `at` says what the pointer is over, so another screen (another
size, zoom, scroll or folded groups) shows it over the same thing; `x` and `y` (fractions 0 to 1 of
the board area) are the fallback when `at` is missing or can't be found there.

```ts
type CursorAnchor =
  | { k: 't'; day: string; dx: number; row: string | null; ry: number } // chart timeline
  | { k: 'l'; fx: number; row: string; ry: number } // chart task list
  | { k: 'e'; key: string; fx: number; fy: number }; // an element marked data-cursor-anchor
```

- `t`: a day (`YYYY-MM-DD`) and how far into it (`dx`), and a row: a task id, or the chart's own
  ids for the Events lane and the empty rows; `null` over the dates header (then `ry` is how far
  down the header).
- `l`: a row of the chart's task list, how far across the list (`fx`) and down the row (`ry`).
- `e`: a marked element (`card:projects`, `card:add-task`, `card:tasks`, `card:chart`,
  `chart:toolbar`, `task:<id>` in the task board) and where in it.

All fractions are 0 to 1. A row folded away on the other screen shows on its group's row; a day or
row scrolled out of view there hides the cursor. The others in the room get:

```ts
interface CursorMessage {
  projectId: string;
  id: string; // the tab, as in the presence list
  userId: string;
  name: string;
  x: number | null; // null: hidden
  y: number | null;
  at?: CursorAnchor;
}
```

The server rebuilds `at` field by field (nothing else passes through) and drops a malformed one,
not the cursor.

Never sent back to the sender, nor outside the room. The server adds who it is (a tab can't send
someone else's name), drops malformed ones and more than one every 30 ms per tab (a hide always goes
through), and sends them volatile: under load a cursor is dropped, the next one replaces it. A tab
that leaves the room disappears from the presence list: clients drop its cursor then.

## Rules the server keeps

- **After the save only.** The message goes out when the whole request has succeeded, so every
  transaction in it has committed.
- **One message per request.** A request can save many rows: a date edit can refit groups and
  push linked tasks. It is still one message, about the row the request was about, and its
  `changes` has every row it changed. Without `changes`, reload the whole list (tasks and links
  together), not that one row.
- **Refused requests (4xx) send nothing.** They saved nothing.
- **Failures (5xx) send `resync`.** A write to a project's tasks, links, events or settings is one
  transaction and saves nothing when it fails; other writes (members) may have saved part of their
  work. Either way, reload the project.
- **Never sent to the tab that made the change**, if it sent `X-Client-Id`.
- **Sending never fails or slows a request.** Messages go out after the answer.

## What the client should do

- With `changes`: apply them (put each row in its list, take out the deleted ids, merge the
  project's fields) and load nothing. Without, as below.
- `task` or `dependency`: reload the tasks and links of the project.
- `event`: reload the events.
- `project` `update`: reload the project (name, archived).
- `project` `delete`: leave it, and show another project.
- `resync`: reload everything of the project.
- `revision`: a task, an event or the project was restored from its history: reload everything
  of the project, and its history if it is shown. (Any change adds to the history: reload a shown
  history on every message.)
- `version`: a version was saved, starred, or restored (then the whole project changed): reload
  everything of the project, and its versions if they are shown.
- `member`: reload the members. When it is about you (or a project you don't have open), reload
  your project list too: your role in it, or the project itself, changed. Removed from the project
  you have open: leave it, and show another project.
- `invitation`: reload the members and the invitations (an open members panel).
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

- **The token is checked when connecting**, and the connection is closed when the token runs out
  (`disconnect` with the reason `io server disconnect`: the app then checks the session, which signs
  it out). It can't join a project it is not a member of.
- **Signing out everywhere closes the connections.** `POST /auth/signout-all` raises the account's
  `tokenVersion`, which ends every token made before it (the API and a new socket refuse them with
  `Your session has ended. Sign in again`), and the gateway closes that account's open sockets at
  once (they would otherwise stay until their token runs out). The auth module tells the gateway
  through `SessionEvents` (auth/token.ts): the realtime module already depends on auth, so auth
  can't call it directly.
- **One server instance.** Rooms live in memory. Running several instances needs socket.io's Redis
  adapter.
- **No conflict detection.** Two people saving the same task: the last save wins. Version checks
  are #21.
