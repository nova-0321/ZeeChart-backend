# Conflicts: two people editing the same thing

Two people can change the same task at once. Without a check, the last save wins and the other
change is lost without anyone knowing. Issue: #21. Source: `src/revisions/conflicts.ts`.

## Versions

Projects, tasks, events and links have a `version`: how many changes they have had. It is the same
number as their latest revision in the history (`GET /projects/:id/revisions`). Every answer that
returns a row returns its version, and a write answers with the new one.

Not to be confused with the **saved versions** of a whole project (v1, v2… in the History panel,
`/projects/:id/versions`): those are snapshots, this is a counter per row.

## Sending the version you saw

A write that changes an existing row (`PATCH`, `DELETE`, and the task routes `/parent`, `/move` and
`/type`) may send the version the client last saw, in a header:

```http
PATCH /tasks/6f1c… HTTP/1.1
If-Match: 4
Content-Type: application/json

{ "startDate": "2026-11-09", "endDate": "2026-11-12" }
```

`4`, `"4"` and `W/"4"` are all accepted; anything else is a `400`. Without the header there is no
check (the write goes through, as before).

## When it is refused

Only when **someone else** changed, after that version, **one of the fields this write changes**:

| Since your version…                                                            | Result                   |
| ------------------------------------------------------------------------------ | ------------------------ |
| nothing changed                                                                | saved                    |
| you changed it yourself (another tab, a quick second save)                     | saved                    |
| someone else changed other fields (you move the dates, they changed the color) | saved, both changes kept |
| someone else changed the same fields                                           | **409**, nothing saved   |

A deletion counts as changing every field. A change the server made because of another (a group
stretched over its tasks, a task pushed by a link) counts as made by whoever's request caused it.

The `409` says who and what, and carries the row as it is now:

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "message": "Bob changed the dates of “Design” meanwhile. Your change wasn't saved",
  "details": {
    "conflict": true,
    "fields": ["startDate", "endDate"],
    "changedBy": { "id": "…", "name": "Bob" },
    "current": { "id": "…", "name": "Design", "startDate": "2026-11-20", "…": "…" },
    "version": 7
  }
}
```

To keep your change anyway, send it again with `If-Match: 7` (the `version` in `details`).

## Limits

- The check and the write happen one after another per project, under a database lock, so this
  holds with several server instances too.
- Creating a row has nothing to check.
