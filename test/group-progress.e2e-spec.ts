import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/validation.js';
import { GroupProgressFromTasks1793100000000 } from '../src/database/migrations/1793100000000-GroupProgressFromTasks.js';
import { groupProgress, type ProgressRow } from '../src/tasks/scheduling/group-progress.js';
import { deleteTestAccounts } from './cleanup.js';

// A group's progress is the average of its tasks (#80): every write that can change one leaves
// every group (and the groups above it) at the plain mean of its direct tasks, milestones left
// out, an empty group at 0%. A progress sent for a group is refused, not ignored.

/** An index past the end of any list: /move puts the task last. */
const LAST = 10_000;

interface TaskBody {
  id: string;
  name: string;
  type: string;
  progress: number;
  parentId: string | null;
  changes?: { tasks?: { upsert: TaskBody[] } };
}
interface Account {
  token: string;
  email: string;
}

describe('Group progress: the average of its tasks (e2e)', () => {
  let app: INestApplication;
  let ann: Account;
  let bob: Account;
  let projectId = '';

  const http = () => request(app.getHttpServer());
  const as = (who: Account, call: request.Test) => call.set('Authorization', `Bearer ${who.token}`);
  const signUp = async (name: string): Promise<Account> => {
    const email = `zzprogress-${name}-${randomUUID()}@example.com`;
    const body = (
      await http().post('/auth/signup').send({ name, email, password: 'pass-word-1' }).expect(201)
    ).body as { accessToken: string };
    return { token: body.accessToken, email };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
    ann = await signUp('ann');
    bob = await signUp('bob');
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzprogress-');
    await app.close();
  });

  beforeEach(async () => {
    projectId = (
      (
        await as(ann, http().post('/projects'))
          .send({ name: `zzprogress ${randomUUID()}` })
          .expect(201)
      ).body as { id: string }
    ).id;
  });

  const newTask = async (name: string, extra: object = {}, who = ann) =>
    (
      await as(who, http().post('/tasks'))
        .send({
          projectId,
          name,
          color: '#2a78d6',
          startDate: '2026-11-02',
          endDate: '2026-11-03',
          ...extra,
        })
        .expect(201)
    ).body as TaskBody;
  const setProgress = (id: string, progress: number, who = ann) =>
    as(who, http().patch(`/tasks/${id}`))
      .send({ progress })
      .expect(200);
  const progressOf = async (...names: string[]) => {
    const all = (await as(ann, http().get(`/tasks?projectId=${projectId}`)).expect(200))
      .body as TaskBody[];
    return Object.fromEntries(
      names.map((name) => [name, all.find((t) => t.name === name)?.progress]),
    );
  };
  /** G holds A (40) and B (80). */
  const groupOfTwo = async () => {
    const g = await newTask('G', { type: 'group' });
    const a = await newTask('A', { parentId: g.id, progress: 40 });
    const b = await newTask('B', { parentId: g.id, progress: 80 });
    return { g, a, b };
  };

  it("a task's progress edited: its group, and the group above, follow at once", async () => {
    const top = await newTask('Top', { type: 'group' });
    const g = await newTask('G', { type: 'group', parentId: top.id });
    const a = await newTask('A', { parentId: g.id });
    await newTask('B', { parentId: g.id, progress: 50 });
    await newTask('C', { parentId: top.id, progress: 100 });

    const answer = (await setProgress(a.id, 100)).body as TaskBody;

    // G = (100 + 50) / 2 = 75; Top = (G 75 + C 100) / 2 = 88 (87.5 rounded).
    expect(await progressOf('G', 'Top')).toEqual({ G: 75, Top: 88 });
    // The answer carries the groups it changed, as the change message does for other tabs.
    const changed = Object.fromEntries(
      (answer.changes?.tasks?.upsert ?? []).map((task) => [task.name, task.progress]),
    );
    expect(changed).toMatchObject({ A: 100, G: 75, Top: 88 });
  });

  it('a task made in a group, deleted from it, or moved between groups: both groups follow', async () => {
    const { g, a } = await groupOfTwo();
    expect(await progressOf('G')).toEqual({ G: 60 });

    const c = await newTask('C', { parentId: g.id }); // 0%
    expect(await progressOf('G')).toEqual({ G: 40 });

    await as(ann, http().delete(`/tasks/${c.id}`)).expect(204);
    expect(await progressOf('G')).toEqual({ G: 60 });

    const h = await newTask('H', { type: 'group' });
    await as(ann, http().patch(`/tasks/${a.id}/move`))
      .send({ parentId: h.id, index: LAST })
      .expect(200);
    expect(await progressOf('G', 'H')).toEqual({ G: 80, H: 40 });
  });

  it('milestones are left out; an empty group is 0%', async () => {
    const { g, a, b } = await groupOfTwo();
    await as(ann, http().patch(`/tasks/${a.id}/type`))
      .send({ type: 'milestone' })
      .expect(200);
    expect(await progressOf('G')).toEqual({ G: 80 });

    await as(ann, http().delete(`/tasks/${b.id}`)).expect(204);
    await as(ann, http().delete(`/tasks/${a.id}`)).expect(204);
    expect(await progressOf('G')).toEqual({ G: 0 });
    expect(g.progress).toBe(0);
  });

  it("a group's progress is refused (400), on create and on edit, and nothing changes", async () => {
    const { g } = await groupOfTwo();
    const create = await as(ann, http().post('/tasks'))
      .send({
        projectId,
        name: 'Typed',
        type: 'group',
        progress: 30,
        color: '#2a78d6',
        startDate: '2026-11-02',
        endDate: '2026-11-03',
      })
      .expect(400);
    expect((create.body as { message: string }).message).toContain(
      "A group's progress is the average of its tasks",
    );
    await as(ann, http().patch(`/tasks/${g.id}`))
      .send({ progress: 10 })
      .expect(400);
    expect(await progressOf('G', 'Typed')).toEqual({ G: 60, Typed: undefined });
    // The rest of a group still edits.
    await as(ann, http().patch(`/tasks/${g.id}`))
      .send({ name: 'Phase' })
      .expect(200);
    expect(await progressOf('Phase')).toEqual({ Phase: 60 });
  });

  it("the group's change is in the history, in the same batch as the task's", async () => {
    const { a } = await groupOfTwo();
    await setProgress(a.id, 100);
    const history = (await as(ann, http().get(`/projects/${projectId}/revisions`)).expect(200))
      .body as { entityId: string; summary: string; batchId: string }[];
    const ofA = history.find((revision) => /“A”/.test(revision.summary))!;
    const ofG = history.find((revision) => /“G”/.test(revision.summary))!;
    expect(ofA.summary).toMatch(/progress 40% → 100%/i);
    expect(ofG.summary).toMatch(/progress 60% → 90%/i);
    // One write: one batch (one undo puts both back).
    expect(ofG.batchId).toBe(ofA.batchId);
  });

  it("undo isn't refused because a teammate's task moved the group meanwhile; the group follows", async () => {
    await as(ann, http().post(`/projects/${projectId}/invitations`))
      .send({ email: bob.email })
      .expect(201);
    const { a, b } = await groupOfTwo();
    await setProgress(a.id, 100, ann); // G 90
    await setProgress(b.id, 0, bob); // G 50: Bob's change moved the group Ann's change touched

    await as(ann, http().post(`/projects/${projectId}/undo`)).expect(200);

    // Ann's A is back at 40; Bob's B stays at 0; G is their average.
    expect(await progressOf('A', 'B', 'G')).toEqual({ A: 40, B: 0, G: 20 });
  });

  it('restoring a version, and copying one, leave every group at its average', async () => {
    const { a } = await groupOfTwo();
    // As a version saved before #80 could hold: a group's progress typed in.
    await app
      .get(DataSource)
      .query(`UPDATE "tasks" SET "progress" = 5 WHERE "name" = 'G' AND "projectId" = $1`, [
        projectId,
      ]);
    const version = (await as(ann, http().post(`/projects/${projectId}/versions`)).expect(201))
      .body as { id: string };
    await setProgress(a.id, 100);

    await as(ann, http().post(`/versions/${version.id}/restore`)).expect(200);
    expect(await progressOf('A', 'G')).toEqual({ A: 40, G: 60 });

    const copy = (await as(ann, http().post(`/versions/${version.id}/copy`)).expect(201)).body as {
      id: string;
    };
    const copied = (await as(ann, http().get(`/tasks?projectId=${copy.id}`)).expect(200))
      .body as TaskBody[];
    expect(copied.find((task) => task.name === 'G')?.progress).toBe(60);
    await as(ann, http().delete(`/projects/${copy.id}`)).expect(204);
  });

  it('the migration sets every group saved before to its average', async () => {
    await groupOfTwo();
    const db = app.get(DataSource);
    await db.query(`UPDATE "tasks" SET "progress" = 3 WHERE "name" = 'G' AND "projectId" = $1`, [
      projectId,
    ]);
    expect(await progressOf('G')).toEqual({ G: 3 });

    const runner = db.createQueryRunner();
    try {
      await new GroupProgressFromTasks1793100000000().up(runner);
    } finally {
      await runner.release();
    }
    expect(await progressOf('G')).toEqual({ G: 60 });
  });

  it("the migration's rule is the app's: same result on every kind of tree", async () => {
    const top = await newTask('Top', { type: 'group' });
    const g = await newTask('G', { type: 'group', parentId: top.id });
    await newTask('A', { parentId: g.id, progress: 33 });
    await newTask('B', { parentId: g.id, progress: 100 });
    await newTask('M', { parentId: g.id, type: 'milestone' });
    await newTask('C', { parentId: top.id, progress: 10 });
    await newTask('Empty', { type: 'group', parentId: top.id });
    const db = app.get(DataSource);
    await db.query(
      `UPDATE "tasks" SET "progress" = 99 WHERE "type" = 'group' AND "projectId" = $1`,
      [projectId],
    );
    const rows = (await db.query(
      `SELECT "id", "parentId", "type", "progress" FROM "tasks" WHERE "projectId" = $1`,
      [projectId],
    )) as ProgressRow[];
    const expected = groupProgress(rows);

    const runner = db.createQueryRunner();
    try {
      await new GroupProgressFromTasks1793100000000().up(runner);
    } finally {
      await runner.release();
    }
    const after = (await db.query(
      `SELECT "id", "progress" FROM "tasks" WHERE "type" = 'group' AND "projectId" = $1`,
      [projectId],
    )) as { id: string; progress: number }[];
    expect(Object.fromEntries(after.map((row) => [row.id, row.progress]))).toEqual(
      Object.fromEntries(expected),
    );
    // G = (33 + 100) / 2 = 67 (66.5 rounded); Top = (G 67 + C 10 + Empty 0) / 3 = 26 (25.67).
    expect(await progressOf('G', 'Top', 'Empty')).toEqual({ G: 67, Top: 26, Empty: 0 });
  });
});
