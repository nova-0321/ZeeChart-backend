# Realtime project sync

When a change is saved, everyone else who has that project open is told right away, so they can
load it again. The message only says _what_ changed. The data always comes from the REST API.

Source: `src/realtime/`. Issue: #28.

## Connecting

socket.io 4, on the same host and port as the API. Allowed origins are the same as the API
(`CORS_ORIGIN`).

```ts
import { io } from 'socket.io-client';

const clientId = crypto.randomUUID(); // once per browser tab
const socket = io(import.meta.env.VITE_API_BASE_URL, { auth: { clientId } });
```

Send the same id on **every** API request, in the `X-Client-Id` header. The server then knows which
tab made a change and doesn't send it back to that tab. The id must be a UUID. Without it, or with
anything else, the tab still connects, but it gets its own changes back too.

## Rooms

A socket is in at most one project's room at a time.

| Send                    | Answer (acknowledgement)                                                |
| ----------------------- | ----------------------------------------------------------------------- |
| `join`, `{ projectId }` | `{ ok: true }`, or `{ ok: false, error }` for a malformed or unknown id |
| `leave`                 | `{ ok: true }`                                                          |

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
  entity: 'project' | 'task' | 'dependency' | 'event';
  action: 'create' | 'update' | 'delete' | 'resync';
  id?: string; // the row the request was about; absent for resync
}
```

| Routes                                                      | Message                                                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `POST /tasks`                                               | `task` `create`, the new task's id                                                      |
| `PATCH /tasks/:id`, `/:id/parent`, `/:id/move`, `/:id/type` | `task` `update`                                                                         |
| `DELETE /tasks/:id`                                         | `task` `delete`                                                                         |
| `POST`, `PATCH`, `DELETE /dependencies`                     | `dependency` `create` / `update` / `delete`                                             |
| `POST`, `PATCH`, `DELETE /events`                           | `event` `create` / `update` / `delete`                                                  |
| `PATCH /projects/:id`, `/:id/archive`, `/:id/reopen`        | `project` `update`                                                                      |
| `DELETE /projects/:id`                                      | `project` `delete` (whoever has it open should move off it)                             |
| `POST /projects`                                            | nothing: only the owner changes the project list, and no one is in a new project's room |

## Presence: who has the project open

A second event, `presence`, goes to a project's room whenever the list changes: someone joins
(the room they left is told too), leaves, or disconnects.

```ts
interface PresenceMessage {
  projectId: string;
  members: string[]; // in the order they joined
}
```

A member is a tab's client id, or `guest:<socket id>` for a tab that connected without one. A tab
connected twice (with the same client id) counts once. With no sign-in yet, ids are all there is;
with accounts (#18) this can carry people instead.

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

- **No sign-in yet.** Anyone who can reach the API can join any project's room, as with the REST
  API. When sign-in and members (#18) come, the checks go in the gateway's connect and `join`.
- **One server instance.** Rooms live in memory. Running several instances needs socket.io's Redis
  adapter.
- **No conflict detection.** Two people saving the same task: the last save wins. Version checks
  are #21.
