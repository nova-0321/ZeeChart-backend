import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { deleteTestAccounts } from './cleanup.js';
import { createValidationPipe } from '../src/common/validation.js';

// Undo and redo of one's own changes (from the history), copying a version into a new project,
// what a version restore removes, and how many versions are kept.

interface Account {
  token: string;
  id: string;
  email: string;
}
interface TaskBody {
  id: string;
  name: string;
  parentId: string | null;
  startDate: string;
  endDate: string;
}
interface UndoState {
  undo: { batchId: string; summary: string } | null;
  redo: { batchId: string; summary: string } | null;
}

describe('Undo, redo and versions (e2e)', () => {
  let app: INestApplication;
  let db: DataSource;
  const http = () => request(app.getHttpServer());
  const as = (account: Account, call: request.Test) =>
    call.set('Authorization', `Bearer ${account.token}`);

  const signUp = async (name: string): Promise<Account> => {
    const body = (
      await http()
        .post('/auth/signup')
        .send({ name, email: `zzundo-${randomUUID()}@example.com`, password: 'pass-word-1' })
        .expect(201)
    ).body as { accessToken: string; user: { id: string; email: string } };
    return { token: body.accessToken, id: body.user.id, email: body.user.email };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
    db = app.get(DataSource);
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzundo-');
    await app.close();
  });

  const setUp = async () => {
    const owner = await signUp('Olive');
    const project = (
      await as(owner, http().post('/projects'))
        .send({ name: `zzundo ${randomUUID()}` })
        .expect(201)
    ).body as { id: string; name: string };
    return { owner, projectId: project.id, projectName: project.name };
  };
  const newTask = (who: Account, projectId: string, body: object) =>
    as(who, http().post('/tasks'))
      .send({
        projectId,
        name: 'Task',
        color: '#2a78d6',
        startDate: '2026-11-02',
        endDate: '2026-11-06',
        ...body,
      })
      .expect(201)
      .then((r) => r.body as TaskBody);
  const tasksOf = async (who: Account, projectId: string) =>
    (await as(who, http().get(`/tasks?projectId=${projectId}`)).expect(200)).body as TaskBody[];
  const linksOf = async (who: Account, projectId: string) =>
    (await as(who, http().get(`/dependencies?projectId=${projectId}`)).expect(200)).body as {
      id: string;
      fromTaskId: string;
      toTaskId: string;
      lagDays: number;
    }[];
  const state = async (who: Account, projectId: string) =>
    (await as(who, http().get(`/projects/${projectId}/undo-state`)).expect(200)).body as UndoState;
  const undo = (who: Account, projectId: string) =>
    as(who, http().post(`/projects/${projectId}/undo`));
  const redo = (who: Account, projectId: string) =>
    as(who, http().post(`/projects/${projectId}/redo`));
  const days = (task: TaskBody) => `${task.startDate.slice(0, 10)}..${task.endDate.slice(0, 10)}`;

  it('undo and redo walk back and forth through your changes', async () => {
    const { owner, projectId } = await setUp();
    const task = await newTask(owner, projectId, { name: 'Design' });
    await as(owner, http().patch(`/tasks/${task.id}`))
      .send({ name: 'Design v2' })
      .expect(200);
    expect((await state(owner, projectId)).undo?.summary).toBe('Renamed “Design” to “Design v2”');

    await undo(owner, projectId).expect(200);
    expect((await tasksOf(owner, projectId))[0]!.name).toBe('Design');
    await undo(owner, projectId).expect(200);
    expect(await tasksOf(owner, projectId)).toEqual([]);
    // Back to the project's creation: nothing more of yours to undo here.
    const s = await state(owner, projectId);
    expect(s.redo?.summary).toBe('Added task “Design”');

    await redo(owner, projectId).expect(200);
    expect((await tasksOf(owner, projectId)).map((t) => [t.id, t.name])).toEqual([
      [task.id, 'Design'],
    ]);
    await redo(owner, projectId).expect(200);
    expect((await tasksOf(owner, projectId))[0]!.name).toBe('Design v2');
    const end = await redo(owner, projectId);
    expect(end.status).toBe(409);
    expect((end.body as { message: string }).message).toBe('Nothing to redo');
  });

  // #57: the state is GET undo-state; GET undo (its old name, read like the action) answers the
  // same until the frontend has moved; undo and redo create nothing, so they answer 200.
  it('undo-state, its old name GET undo, and 200 for undo and redo', async () => {
    const { owner, projectId } = await setUp();
    await newTask(owner, projectId, { name: 'Design' });
    const now = await state(owner, projectId);
    const old = await as(owner, http().get(`/projects/${projectId}/undo`)).expect(200);
    expect(old.body).toEqual(now);
    expect(now.undo?.summary).toBe('Added task “Design”');

    expect((await undo(owner, projectId)).status).toBe(200);
    expect((await redo(owner, projectId)).status).toBe(200);
  });

  it('a new change clears what could be redone', async () => {
    const { owner, projectId } = await setUp();
    const task = await newTask(owner, projectId, { name: 'A' });
    await as(owner, http().patch(`/tasks/${task.id}`))
      .send({ name: 'B' })
      .expect(200);
    await undo(owner, projectId).expect(200);
    expect((await state(owner, projectId)).redo).not.toBeNull();
    await as(owner, http().patch(`/tasks/${task.id}`))
      .send({ progress: 30 })
      .expect(200);
    expect((await state(owner, projectId)).redo).toBeNull();
  });

  it('one action comes back whole: an edit that moved a group and a linked task too', async () => {
    const { owner, projectId } = await setUp();
    const group = await newTask(owner, projectId, { name: 'Phase', type: 'group' });
    const child = await newTask(owner, projectId, { name: 'Build', parentId: group.id });
    const next = await newTask(owner, projectId, {
      name: 'Ship',
      startDate: '2026-11-09',
      endDate: '2026-11-10',
    });
    await as(owner, http().post('/dependencies'))
      .send({ fromTaskId: child.id, toTaskId: next.id })
      .expect(201);
    const before = (await tasksOf(owner, projectId)).map((t) => [t.name, days(t)]).sort();
    await as(owner, http().patch(`/tasks/${child.id}`))
      .send({ startDate: '2026-11-23', endDate: '2026-11-27' })
      .expect(200);
    await undo(owner, projectId).expect(200);
    expect((await tasksOf(owner, projectId)).map((t) => [t.name, days(t)]).sort()).toEqual(before);
  });

  it('links: undo a new link removes it; undo an unlink brings it back (same id)', async () => {
    const { owner, projectId } = await setUp();
    const a = await newTask(owner, projectId, { name: 'A' });
    const b = await newTask(owner, projectId, {
      name: 'B',
      startDate: '2026-11-09',
      endDate: '2026-11-10',
    });
    const link = (
      await as(owner, http().post('/dependencies'))
        .send({ fromTaskId: a.id, toTaskId: b.id })
        .expect(201)
    ).body as { id: string };
    expect((await state(owner, projectId)).undo?.summary).toBe('Linked “A” → “B”');
    await undo(owner, projectId).expect(200);
    expect(await linksOf(owner, projectId)).toEqual([]);
    await redo(owner, projectId).expect(200);
    await as(owner, http().delete(`/dependencies/${link.id}`)).expect(204);
    await undo(owner, projectId).expect(200);
    expect((await linksOf(owner, projectId)).map((l) => l.id)).toEqual([link.id]);
  });

  it('a deleted task comes back with its links and its group', async () => {
    const { owner, projectId } = await setUp();
    const group = await newTask(owner, projectId, { name: 'Phase', type: 'group' });
    const doomed = await newTask(owner, projectId, { name: 'Doomed', parentId: group.id });
    const after = await newTask(owner, projectId, {
      name: 'After',
      startDate: '2026-11-09',
      endDate: '2026-11-10',
    });
    await as(owner, http().post('/dependencies'))
      .send({ fromTaskId: doomed.id, toTaskId: after.id })
      .expect(201);
    await as(owner, http().delete(`/tasks/${doomed.id}`)).expect(204);
    await undo(owner, projectId).expect(200);
    const back = (await tasksOf(owner, projectId)).find((t) => t.id === doomed.id);
    expect(back).toMatchObject({ name: 'Doomed', parentId: group.id });
    expect((await linksOf(owner, projectId)).map((l) => [l.fromTaskId, l.toTaskId])).toEqual([
      [doomed.id, after.id],
    ]);
  });

  it("only your own changes; someone else's change since blocks it (409), nothing written", async () => {
    const { owner, projectId } = await setUp();
    const bob = await signUp('Bob');
    await as(owner, http().post(`/projects/${projectId}/invitations`))
      .send({ email: bob.email })
      .expect(201);
    const task = await newTask(owner, projectId, { name: 'Olive’s' });
    await as(bob, http().patch(`/tasks/${task.id}`))
      .send({ progress: 50 })
      .expect(200);
    // Bob's undo is his progress change; Olive's is her new task, which Bob has changed since.
    expect((await state(bob, projectId)).undo?.summary).toMatch(/Progress 0% → 50%/);
    const refused = await undo(owner, projectId);
    expect(refused.status).toBe(409);
    expect((refused.body as { message: string }).message).toBe(
      "Can't undo: “Olive’s” was changed since",
    );
    expect((await tasksOf(owner, projectId)).length).toBe(1);
    // After Bob undoes his, Olive's goes through.
    await undo(bob, projectId).expect(200);
    await undo(owner, projectId).expect(200);
    expect(await tasksOf(owner, projectId)).toEqual([]);
  });

  it("viewers can't undo; others see nothing", async () => {
    const { owner, projectId } = await setUp();
    const viewer = await signUp('Vi');
    const stranger = await signUp('Stranger');
    await as(owner, http().post(`/projects/${projectId}/invitations`))
      .send({ email: viewer.email, role: 'viewer' })
      .expect(201);
    expect(await state(viewer, projectId)).toEqual({ undo: null, redo: null });
    await undo(viewer, projectId).expect(403);
    await as(stranger, http().get(`/projects/${projectId}/undo-state`)).expect(404);
    await undo(stranger, projectId).expect(404);
  });

  it('copy a version into a new project of yours; the original is untouched', async () => {
    const { owner, projectId, projectName } = await setUp();
    const group = await newTask(owner, projectId, { name: 'Phase', type: 'group' });
    const child = await newTask(owner, projectId, { name: 'Build', parentId: group.id });
    const ship = await newTask(owner, projectId, {
      name: 'Ship',
      startDate: '2026-11-09',
      endDate: '2026-11-10',
    });
    await as(owner, http().post('/dependencies'))
      .send({ fromTaskId: child.id, toTaskId: ship.id })
      .expect(201);
    const version = (await as(owner, http().post(`/projects/${projectId}/versions`)).expect(201))
      .body as { id: string; number: number };
    const copy = (await as(owner, http().post(`/versions/${version.id}/copy`)).expect(201))
      .body as { id: string; name: string; role: string };
    expect(copy).toMatchObject({ name: `${projectName} (v${version.number})`, role: 'owner' });
    const copied = await tasksOf(owner, copy.id);
    expect(copied.map((t) => t.name).sort()).toEqual(['Build', 'Phase', 'Ship']);
    expect(copied.some((t) => [group.id, child.id, ship.id].includes(t.id))).toBe(false);
    const phase = copied.find((t) => t.name === 'Phase')!;
    expect(copied.find((t) => t.name === 'Build')!.parentId).toBe(phase.id);
    expect((await linksOf(owner, copy.id)).length).toBe(1);
    // Its v1 holds what it was made from.
    const [v1] = (await as(owner, http().get(`/projects/${copy.id}/versions`)).expect(200))
      .body as { tasks: number }[];
    expect(v1!.tasks).toBe(3);
    // A second copy gets its own name.
    const again = (await as(owner, http().post(`/versions/${version.id}/copy`)).expect(201))
      .body as { name: string };
    expect(again.name).toBe(`${projectName} (v${version.number}) 2`);
    expect((await tasksOf(owner, projectId)).length).toBe(3);
  });

  it('restoring a version removes the newer auto ones, keeps starred, manual and the one it saved', async () => {
    const { owner, projectId } = await setUp();
    const save = () => as(owner, http().post(`/projects/${projectId}/versions`)).expect(201);
    const auto = async (name: string) => {
      await db.query(
        `UPDATE "project_versions" SET "createdAt" = "createdAt" - interval '1 hour' WHERE "projectId" = $1`,
        [projectId],
      );
      await newTask(owner, projectId, { name });
    };
    await auto('A'); // v2 auto
    // A change first: saving what v2 already holds would keep v2 itself, not make v3.
    await newTask(owner, projectId, { name: 'A2' });
    await save(); // v3 manual
    await auto('B'); // v4 auto
    await auto('C'); // v5 auto
    const list = async () =>
      (
        (await as(owner, http().get(`/projects/${projectId}/versions`)).expect(200)).body as {
          id: string;
          number: number;
          kind: string;
        }[]
      ).map((v) => v);
    const v4 = (await list()).find((v) => v.number === 4)!;
    await as(owner, http().patch(`/versions/${v4.id}`))
      .send({ starred: true })
      .expect(200);
    await newTask(owner, projectId, { name: 'D' }); // not in any version yet
    const v2 = (await list()).find((v) => v.number === 2)!;
    const result = (await as(owner, http().post(`/versions/${v2.id}/restore`)).expect(200))
      .body as { savedAs: number };
    expect(result.savedAs).toBe(6);
    expect((await list()).map((v) => [v.number, v.kind])).toEqual([
      [6, 'before-restore'],
      [4, 'auto'],
      [3, 'manual'],
      [2, 'auto'],
      [1, 'auto'],
    ]);
  });

  it('only the 30 newest versions are kept, besides starred and manual ones', async () => {
    const { owner, projectId } = await setUp();
    const [v1] = (await as(owner, http().get(`/projects/${projectId}/versions`)).expect(200))
      .body as { id: string }[];
    await as(owner, http().patch(`/versions/${v1!.id}`))
      .send({ starred: true })
      .expect(200);
    for (let k = 0; k < 33; k++) {
      await db.query(
        `UPDATE "project_versions" SET "createdAt" = "createdAt" - interval '1 hour' WHERE "projectId" = $1`,
        [projectId],
      );
      await newTask(owner, projectId, { name: `T${k}` });
    }
    const all = (await as(owner, http().get(`/projects/${projectId}/versions`)).expect(200))
      .body as { number: number; starred: boolean }[];
    expect(all.length).toBe(31);
    expect(all.at(-1)).toMatchObject({ number: 1, starred: true });
    expect(all[0]!.number).toBe(34);
    // 33 changes, each saving a whole version: longer than the default 5 s on a slow machine.
  }, 20_000);
});
