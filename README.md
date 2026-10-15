# ZeeChart API

The backend of ZeeChart, a shared Gantt chart: projects, their tasks, groups and links, events,
members and invitations, the history of every change (undo, redo, saved versions, restoring), and
live updates to everyone with a project open. NestJS 11, TypeORM, PostgreSQL, socket.io.

## Run it locally

Needs Node 24 and PostgreSQL.

```bash
npm install
cp .env.example .env      # then set JWT_SECRET (the command to make one is in the file's comments)
npm run db:setup          # creates the dev database and user (asks for the postgres password)
npm run migration:run     # creates the tables
npm run start:dev         # http://localhost:3000, reloads on change
```

- `GET /health` says whether the API is up.
- The API docs (Swagger UI) are at `/docs` and the spec at `/docs-json`, except in production
  unless `API_DOCS=true`. The frontend's types are made from `openapi.json` (see below).

Every setting is checked at startup, all at once, with a message for each missing or wrong one:
`src/config/env.validation.ts` lists them and says what each is for.

## Scripts

| Script                                                         | What it does                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm test`                                                     | Unit tests (Vitest)                                                               |
| `npm run test:e2e`                                             | End-to-end tests: the whole app against a real database (`NODE_ENV=test`)         |
| `npm run test:cov`                                             | Unit tests with coverage; fails under the thresholds in `vitest.config.ts`        |
| `npm run lint` / `npm run typecheck` / `npm run format:check`  | ESLint, TypeScript, Prettier                                                      |
| `npm run migration:generate -- src/database/migrations/<Name>` | A migration from entity changes                                                   |
| `npm run migration:check`                                      | Fails when the entities and the migrations disagree                               |
| `npm run openapi:generate`                                     | Writes `openapi.json` from the code; `openapi:check` fails when it is out of date |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, Prettier, `npm audit`, the unit tests with
coverage and the build, and the e2e tests on a fresh PostgreSQL.

## How the code is laid out

`src/<domain>/` per domain: `auth`, `projects`, `members`, `tasks` (with `tasks/scheduling`, the
engine that fits groups to their tasks and pushes linked tasks), `dependencies` (links), `events`,
`revisions` (history, undo, versions), `realtime`. Each has its `entities/`, `dto/`, module,
controller(s) and service. A domain reads another's data through that domain's service or exported
functions, never through its entities or tables: ESLint enforces it (`eslint.config.mjs`).

Shared pieces: `common/` (error envelope, validation, rate limits), `config/`, `database/`
(connection, migrations, the per-request transaction and the per-project write lock).

## More

- `docs/database-flow.md`: how a request goes through module, controller, service and database.
- `docs/conflicts.md`: two people editing the same thing (`If-Match`, the 409 answer).
- `docs/realtime.md`: the live connection, rooms and messages.
