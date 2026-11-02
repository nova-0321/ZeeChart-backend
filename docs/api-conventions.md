# API conventions

How the REST routes are named and what they answer, so a new route fits the ones already there.
Issue: #57.

## Status codes

| Answer                                | When                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `201 Created`                         | A `POST` that makes a new row: a project, task, link, event, invitation, version, a copy of a project, an account.                                                                                                                                                                      |
| `200 OK`                              | A read, a change (`PATCH`), and a `POST` that does something without making a row: sign in, preview or accept an invite link, undo, redo, restore a revision or a version. Saving a version answers 200 when nothing changed since the newest one (that one is kept, as saved by hand). |
| `204 No Content`                      | Every `DELETE`, and signing out everywhere: no body.                                                                                                                                                                                                                                    |
| `400` / `401` / `403` / `404` / `409` | See `src/common/all-exceptions.filter.ts` and docs/conflicts.md.                                                                                                                                                                                                                        |

A `POST` that is an action, not a new thing, says so with `@HttpCode(200)`. `POST
/invitations/:id/link` answers 201: it makes a new secret link (the old one stops working).

### 404: "<Thing> not found"

Every 404 says what was missing, never its id: `Task not found`, `Link not found`, `Version not
found`... (#58). Write it with `notFound('Task')` from `src/common/not-found.ts`; a
`findOneByOrFail` that finds nothing is answered the same way by the error filter, named from its
entity. A row in a project you are not in gets exactly the answer a missing one gets (the route's
thing, from its `@ProjectAccess` locator), so the two can't be told apart. A 404 with a reason of
its own keeps it ("No one has signed up with this email", an invite link that expired). A test
fails on a hand-written `'Not found'`, `'Resource not found'` or an id in the text, and on an
entity `notFound` has no name for.

## Naming

- **Files are plural, after the resource:** `tasks/tasks.controller.ts`, `tasks.service.ts`,
  `tasks.module.ts`, and so the classes: `TasksController`, `TasksService`, `TasksModule`. Helpers
  about one row may stay singular (`task-rows.ts`, `task-project.ts`).
- **DTOs:** `Create<Entity>Dto` for a `POST` that makes a row, `Update<Entity>Dto` for its `PATCH`
  (`CreateTaskDto`, `UpdateMemberDto`, `UpdateVersionDto`); a verb only for an action that is not
  a create or an update (`MoveTaskDto`, `ChangeTaskTypeDto`, `AcceptInviteDto`, `SignInDto`). An
  answer's DTO is named for what it is (`MemberDto`, `UndoStateDto`). One file per input DTO,
  named after it (`create-task.dto.ts`).

## One way to do one thing

- **A project's own fields**, archived included, change with `PATCH /projects/:id` (owners). There
  are no `/archive` or `/reopen` routes: archive with `{ "archived": true }`, reopen with
  `{ "archived": false }`. An archived project is read-only for editors until then
  (`project-access.ts`).
- **A task's place**, its group included, changes with `PATCH /tasks/:id/move { parentId, index }`
  (an index past the end puts it last). There is no `/parent` route. Dropped on a plain task, that
  task becomes a group holding it.
- **A group's `progress` is the average of its tasks** (#80): the plain mean of its direct tasks
  (a group inside counts with its own average), milestones left out, 0 with nothing to count,
  rounded to a whole percent. The server sets it at the end of every write (RevisionInterceptor:
  `fitGroupProgress`), so it is in the write's history and `changes` like a group's dates. Sending
  a `progress` for a group is refused (400), never ignored.
- **A task's `order` is its place in its level** (a group's tasks, or the top level), and every
  level is numbered 1, 2, 3... after every write: a new task (its `order` is the place it takes;
  none: last), a delete, a move (the level it leaves closes up too), undo, redo, restoring a
  revision or a version. No gaps, no two on one place. The rows renumbered are in the write's
  `changes` like any other changed row. Migration `NumberTaskLevels` numbered the data already
  stored.
- **A read is named for what it returns.** `GET /projects/:id/undo-state` is what Undo and Redo
  would do; `POST /projects/:id/undo` and `/redo` do it.

## Route style

The project's own children are found two ways today:

- flat, with a query: `GET /tasks?projectId=`, `/events?projectId=`, `/dependencies?projectId=`,
  and by id: `PATCH /tasks/:id`;
- nested: `GET /projects/:id/members`, `/invitations`, `/revisions`, `/versions`, `/undo-state`.

They stay as they are (moving them would change every client for no new behaviour). **A new kind of
project child nests under `/projects/:id/...`**, and its rows are reached by their own id
(`/<kind>/:id`), as members, invitations and versions are. No third style.

## Deprecated routes

A route that is renamed keeps its old path for a while, marked `deprecated` in the OpenAPI document,
so a client already running doesn't break before it is updated. It goes once the clients have moved.

| Old                      | Use                            | Since |
| ------------------------ | ------------------------------ | ----- |
| `GET /projects/:id/undo` | `GET /projects/:id/undo-state` | #57   |

Routes removed without a stand-in (the frontend moves off them before this is deployed):
`PATCH /projects/:id/archive`, `PATCH /projects/:id/reopen`, `PATCH /tasks/:id/parent` (#57).
