import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { deleteTestAccounts } from './cleanup.js';
import { createValidationPipe } from '../src/common/validation.js';

// Fixes from the review of the API (bad input that gave 500s, undo / restore edge cases, members
// leaving, scheduling rules).

interface Account {
  token: string;
  id: string;
  email: string;
}
interface TaskBody {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  description: string | null;
  startDate: string;
  endDate: string;
}

describe('Fixes (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const as = (account: Account, call: request.Test) =>
    call.set('Authorization', `Bearer ${account.token}`);

  const signUp = async (name: string): Promise<Account> => {
    const body = (
      await http()
        .post('/auth/signup')
        .send({ name, email: `zzfix-${randomUUID()}@example.com`, password: 'pass-word-1' })
        .expect(201)
    ).body as { accessToken: string; user: { id: string; email: string } };
    return { token: body.accessToken, id: body.user.id, email: body.user.email };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzfix-');
    await app.close();
  });

  const setUp = async () => {
    const owner = await signUp('Olive');
    const project = (
      await as(owner, http().post('/projects'))
        .send({ name: `zzfix ${randomUUID()}` })
        .expect(201)
    ).body as { id: string };
    return { owner, projectId: project.id };
  };
  const newTask = (who: Account, projectId: string, body: object) =>
    as(who, http().post('/tasks')).send({
      projectId,
      name: 'Task',
      color: '#2a78d6',
      startDate: '2026-11-02',
      endDate: '2026-11-06',
      ...body,
    });
  const tasksOf = async (who: Account, projectId: string) =>
    (await as(who, http().get(`/tasks?projectId=${projectId}`)).expect(200)).body as TaskBody[];
  const day = (iso: string) => iso.slice(0, 10);

  it('dates that do not exist, or are out of range, are a 400 (not a 500, not March)', async () => {
    const { owner, projectId } = await setUp();
    for (const startDate of ['2026-02-30', '0000-01-01', '-0001-01-05', '10000-01-01']) {
      const answer = await newTask(owner, projectId, { startDate, endDate: '2026-03-05' });
      expect([startDate, answer.status]).toEqual([startDate, 400]);
    }
    const task = (await newTask(owner, projectId, {}).expect(201)).body as TaskBody;
    await as(owner, http().patch(`/tasks/${task.id}`))
      .send({ startDate: '2026-02-30', endDate: '2026-03-05' })
      .expect(400);
    await as(owner, http().post('/events'))
      .send({
        projectId,
        name: 'E',
        color: '#e5484d',
        startDate: '2026-02-30',
        endDate: '2026-03-01',
      })
      .expect(400);
    // A link that would push a task past the last year: refused, not a 500.
    const late = (
      await newTask(owner, projectId, { startDate: '9998-12-01', endDate: '9998-12-20' }).expect(
        201,
      )
    ).body as TaskBody;
    const after = (
      await newTask(owner, projectId, { startDate: '9998-12-21', endDate: '9998-12-22' }).expect(
        201,
      )
    ).body as TaskBody;
    const pushed = await as(owner, http().post('/dependencies')).send({
      fromTaskId: late.id,
      toTaskId: after.id,
      lagDays: 30,
    });
    expect(pushed.status).toBe(400);
    expect((pushed.body as { message: string }).message).toMatch(/outside the years 1900–9998/);
    await newTask(owner, projectId, { order: 3_000_000_000 }).expect(400);
  });

  it('project names: only spaces, too long or null are a 400; a copy of a long name fits', async () => {
    const { owner, projectId } = await setUp();
    await as(owner, http().post('/projects')).send({ name: '   ' }).expect(400);
    await as(owner, http().post('/projects'))
      .send({ name: 'x'.repeat(256) })
      .expect(400);
    await as(owner, http().patch(`/projects/${projectId}`))
      .send({ name: null })
      .expect(400);
    const long = `zzfix ${'n'.repeat(249)}`;
    await as(owner, http().patch(`/projects/${projectId}`))
      .send({ name: long })
      .expect(200);
    const version = (await as(owner, http().post(`/projects/${projectId}/versions`)).expect(201))
      .body as { id: string };
    const copy = (await as(owner, http().post(`/versions/${version.id}/copy`)).expect(201))
      .body as { name: string };
    expect(copy.name.length).toBeLessThanOrEqual(255);
    expect(copy.name).toMatch(/ \(v\d+\)$/);
  });

  it('a new project has nothing to undo (making it is not undone)', async () => {
    const { owner, projectId } = await setUp();
    expect((await as(owner, http().get(`/projects/${projectId}/undo`)).expect(200)).body).toEqual({
      undo: null,
      redo: null,
    });
    const answer = await as(owner, http().post(`/projects/${projectId}/undo`));
    expect([answer.status, (answer.body as { message: string }).message]).toEqual([
      409,
      'Nothing to undo',
    ]);
  });

  it('undo keeps a group covering a task someone else put in it since', async () => {
    const { owner, projectId } = await setUp();
    const bob = await signUp('Bob');
    await as(owner, http().post(`/projects/${projectId}/invitations`))
      .send({ email: bob.email })
      .expect(201);
    const group = (
      await newTask(owner, projectId, {
        name: 'G',
        type: 'group',
        startDate: '2026-01-01',
        endDate: '2026-01-05',
      }).expect(201)
    ).body as TaskBody;
    await newTask(owner, projectId, {
      name: 'c1',
      parentId: group.id,
      startDate: '2026-01-06',
      endDate: '2026-01-20',
    }).expect(201);
    await newTask(bob, projectId, {
      name: 'c2',
      parentId: group.id,
      startDate: '2026-01-10',
      endDate: '2026-01-15',
    }).expect(201);
    await as(owner, http().post(`/projects/${projectId}/undo`)).expect(201);
    const tasks = await tasksOf(owner, projectId);
    const g = tasks.find((t) => t.id === group.id)!;
    const c2 = tasks.find((t) => t.name === 'c2')!;
    expect(tasks.some((t) => t.name === 'c1')).toBe(false);
    expect(day(g.startDate) <= day(c2.startDate) && day(g.endDate) >= day(c2.endDate)).toBe(true);
  });

  it('a task made a milestone: its group shrinks to fit (scheduling rules hold)', async () => {
    const { owner, projectId } = await setUp();
    const group = (await newTask(owner, projectId, { name: 'G', type: 'group' }).expect(201))
      .body as TaskBody;
    const child = (
      await newTask(owner, projectId, {
        name: 'C',
        parentId: group.id,
        startDate: '2026-01-02',
        endDate: '2026-01-10',
      }).expect(201)
    ).body as TaskBody;
    await as(owner, http().patch(`/tasks/${child.id}/type`))
      .send({ type: 'milestone' })
      .expect(200);
    const g = (await tasksOf(owner, projectId)).find((t) => t.id === group.id)!;
    expect(`${day(g.startDate)}..${day(g.endDate)}`).toBe('2026-01-02..2026-01-02');
  });

  it('a group with tasks keeps their length (400 when resized), and can be moved', async () => {
    const { owner, projectId } = await setUp();
    const group = (await newTask(owner, projectId, { name: 'G', type: 'group' }).expect(201))
      .body as TaskBody;
    await newTask(owner, projectId, {
      name: 'C',
      parentId: group.id,
      startDate: '2026-03-02',
      endDate: '2026-03-06',
    }).expect(201);
    const wide = await as(owner, http().patch(`/tasks/${group.id}`)).send({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    expect(wide.status).toBe(400);
    expect((wide.body as { message: string }).message).toMatch(/length follows its tasks/);
    await as(owner, http().patch(`/tasks/${group.id}`))
      .send({ startDate: '2026-03-09', endDate: '2026-03-13' })
      .expect(200);
  });

  it('restoring an old state clears a description that was empty then', async () => {
    const { owner, projectId } = await setUp();
    const task = (await newTask(owner, projectId, { name: 'T' }).expect(201)).body as TaskBody;
    await as(owner, http().patch(`/tasks/${task.id}`))
      .send({ description: 'secret' })
      .expect(200);
    const history = (await as(owner, http().get(`/projects/${projectId}/revisions`)).expect(200))
      .body as { id: string; entityId: string; version: number }[];
    const created = history.find((r) => r.entityId === task.id && r.version === 1)!;
    await as(owner, http().post(`/revisions/${created.id}/restore`)).expect(201);
    expect((await tasksOf(owner, projectId)).find((t) => t.id === task.id)!.description).toBeNull();
  });

  it('a restore that is refused changes nothing (no half-applied restore)', async () => {
    const { owner, projectId } = await setUp();
    const group = (await newTask(owner, projectId, { name: 'G', type: 'group' }).expect(201))
      .body as TaskBody;
    await newTask(owner, projectId, { name: 'Keep', parentId: group.id }).expect(201);
    const task = (await newTask(owner, projectId, { name: 'orig', parentId: group.id }).expect(201))
      .body as TaskBody;
    await as(owner, http().patch(`/tasks/${task.id}/parent`))
      .send({ parentId: null })
      .expect(200);
    await as(owner, http().patch(`/tasks/${task.id}`))
      .send({ name: 'renamed' })
      .expect(200);
    await as(owner, http().post('/dependencies'))
      .send({ fromTaskId: task.id, toTaskId: group.id })
      .expect(201);
    const history = (await as(owner, http().get(`/projects/${projectId}/revisions`)).expect(200))
      .body as { id: string; entityId: string; version: number }[];
    const first = history.find((r) => r.entityId === task.id && r.version === 1)!;
    const answer = await as(owner, http().post(`/revisions/${first.id}/restore`));
    expect(answer.status).toBe(400);
    const now = (await tasksOf(owner, projectId)).find((t) => t.id === task.id)!;
    expect([now.name, now.parentId]).toEqual(['renamed', null]);
  });

  it('anyone can leave a project; only owners remove others; the last owner can not leave', async () => {
    const { owner, projectId } = await setUp();
    const ed = await signUp('Ed');
    const vi = await signUp('Vi');
    const edRow = (
      await as(owner, http().post(`/projects/${projectId}/invitations`))
        .send({ email: ed.email })
        .expect(201)
    ).body.member as { id: string };
    const viRow = (
      await as(owner, http().post(`/projects/${projectId}/invitations`))
        .send({ email: vi.email, role: 'viewer' })
        .expect(201)
    ).body.member as { id: string };
    // Ed can't remove Vi; Vi can leave.
    await as(ed, http().delete(`/members/${viRow.id}`)).expect(403);
    await as(vi, http().delete(`/members/${viRow.id}`)).expect(204);
    await as(vi, http().get(`/projects/${projectId}`)).expect(404);
    // Ed leaves too.
    await as(ed, http().delete(`/members/${edRow.id}`)).expect(204);
    // The owner, alone: can't leave.
    const members = (await as(owner, http().get(`/projects/${projectId}/members`)).expect(200))
      .body as { id: string }[];
    await as(owner, http().delete(`/members/${members[0]!.id}`)).expect(409);
  });

  // The list order of a level: names by their place.
  const orderOf = async (who: Account, projectId: string, parentId: string | null = null) =>
    (
      (await as(who, http().get(`/tasks?projectId=${projectId}`)).expect(200)).body as (TaskBody & {
        order: number;
      })[]
    )
      .filter((t) => t.parentId === parentId)
      .sort((a, b) => a.order - b.order)
      .map((t) => t.name)
      .join(' ');

  it('undo of a move puts the task back at its place, keeping a move someone made since', async () => {
    const { owner, projectId } = await setUp();
    const bob = await signUp('Bob');
    await as(owner, http().post(`/projects/${projectId}/invitations`))
      .send({ email: bob.email })
      .expect(201);
    const ids: Record<string, string> = {};
    for (const name of ['a', 'b', 'c', 'd', 't']) {
      ids[name] = ((await newTask(owner, projectId, { name }).expect(201)).body as TaskBody).id;
    }
    await as(owner, http().patch(`/tasks/${ids.t}/move`))
      .send({ parentId: null, index: 0 })
      .expect(200);
    expect(await orderOf(owner, projectId)).toBe('t a b c d');
    // Bob moves b to the end since.
    await as(bob, http().patch(`/tasks/${ids.b}/move`))
      .send({ parentId: null, index: 4 })
      .expect(200);
    expect(await orderOf(owner, projectId)).toBe('t a c d b');
    // Olive's undo: t back at the end (its place then), b stays where Bob put it.
    await as(owner, http().post(`/projects/${projectId}/undo`)).expect(201);
    expect(await orderOf(owner, projectId)).toBe('a c d b t');
    // And redo puts it first again; the next undo goes on to what came before.
    await as(owner, http().post(`/projects/${projectId}/redo`)).expect(201);
    expect(await orderOf(owner, projectId)).toBe('t a c d b');
    const state = (await as(owner, http().get(`/projects/${projectId}/undo`)).expect(200)).body as {
      undo: { summary: string } | null;
    };
    expect(state.undo?.summary).toMatch(/Moved in the list/);
    // One history entry for the move, none for the tasks renumbered around it.
    const history = (await as(owner, http().get(`/projects/${projectId}/revisions`)).expect(200))
      .body as { summary: string; entityId: string }[];
    expect(history.filter((r) => r.entityId === ids.a)).toHaveLength(1);
  });

  it("a task renumbered by someone else's move can still be deleted with the version it had", async () => {
    const { owner, projectId } = await setUp();
    const bob = await signUp('Bob');
    await as(owner, http().post(`/projects/${projectId}/invitations`))
      .send({ email: bob.email })
      .expect(201);
    const a = (await newTask(owner, projectId, { name: 'a' }).expect(201)).body as TaskBody & {
      version: number;
    };
    const b = (await newTask(owner, projectId, { name: 'b' }).expect(201)).body as TaskBody;
    // Bob moves b above a: a is renumbered, not changed.
    await as(bob, http().patch(`/tasks/${b.id}/move`))
      .send({ parentId: null, index: 0 })
      .expect(200);
    await as(owner, http().delete(`/tasks/${a.id}`))
      .set('If-Match', String(a.version))
      .expect(204);
  });

  it('deleting a group inside another puts its tasks in that group, at its place', async () => {
    const { owner, projectId } = await setUp();
    const p = (await newTask(owner, projectId, { name: 'P', type: 'group' }).expect(201))
      .body as TaskBody;
    await newTask(owner, projectId, { name: 'p1', parentId: p.id }).expect(201);
    const g = (
      await newTask(owner, projectId, { name: 'G', type: 'group', parentId: p.id }).expect(201)
    ).body as TaskBody;
    await newTask(owner, projectId, { name: 'p2', parentId: p.id }).expect(201);
    await newTask(owner, projectId, { name: 'c1', parentId: g.id }).expect(201);
    await newTask(owner, projectId, { name: 'c2', parentId: g.id }).expect(201);
    await as(owner, http().delete(`/tasks/${g.id}`)).expect(204);
    expect(await orderOf(owner, projectId, p.id)).toBe('p1 c1 c2 p2');
  });
});
