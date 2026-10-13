import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { deleteTestAccounts } from './cleanup.js';
import { createValidationPipe } from '../src/common/validation.js';

// The history of a project (#19): every change to the project, its tasks and its events is
// recorded, and any of them can be restored.

interface Account {
  token: string;
  id: string;
  email: string;
}
interface RevisionBody {
  id: string;
  entityType: string;
  entityId: string;
  version: number;
  action: string;
  summary: string;
  changedBy: { id: string; name: string } | null;
  batchId: string;
  primary: boolean;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}
interface TaskBody {
  id: string;
  name: string;
  parentId: string | null;
  startDate: string;
  endDate: string;
  type: string;
}

describe('Revisions (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const as = (account: Account, call: request.Test) =>
    call.set('Authorization', `Bearer ${account.token}`);

  const signUp = async (name: string): Promise<Account> => {
    const body = (
      await http()
        .post('/auth/signup')
        .send({ name, email: `zzrev-${randomUUID()}@example.com`, password: 'pass-word-1' })
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
    await deleteTestAccounts(app, 'zzrev-');
    await app.close();
  });

  const setUp = async () => {
    const owner = await signUp('Olive');
    const project = (
      await as(owner, http().post('/projects'))
        .send({ name: `zzrev ${randomUUID()}` })
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
  const history = async (who: Account, projectId: string) =>
    (await as(who, http().get(`/projects/${projectId}/revisions`)).expect(200))
      .body as RevisionBody[];
  const tasksOf = async (who: Account, projectId: string) =>
    (await as(who, http().get(`/tasks?projectId=${projectId}`)).expect(200)).body as TaskBody[];
  const restore = (who: Account, id: string) => as(who, http().post(`/revisions/${id}/restore`));

  it('a new project starts its history; changes follow, newest first, with who made them', async () => {
    const { owner, projectId, projectName } = await setUp();
    const task = await newTask(owner, projectId, { name: 'Design' });
    await as(owner, http().patch(`/tasks/${task.id}`))
      .send({ name: 'Design v2', progress: 40 })
      .expect(200);
    await as(owner, http().delete(`/tasks/${task.id}`)).expect(204);
    const revisions = await history(owner, projectId);
    expect(revisions.map((r) => [r.entityType, r.action, r.version, r.summary])).toEqual([
      ['task', 'delete', 3, 'Deleted task “Design v2”'],
      ['task', 'update', 2, 'Renamed “Design” to “Design v2”; progress 0% → 40%'],
      ['task', 'create', 1, 'Added task “Design”'],
      ['project', 'create', 1, `Created project “${projectName}”`],
    ]);
    expect(revisions.every((r) => r.changedBy?.name === 'Olive')).toBe(true);
    expect(revisions[1]!.before).toMatchObject({ name: 'Design', progress: 0 });
    expect(revisions[1]!.after).toMatchObject({ name: 'Design v2', progress: 40 });
  });

  it('one edit that also moves a group and a linked task: one action (batch), all recorded', async () => {
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
    await as(owner, http().patch(`/tasks/${child.id}`))
      .send({ startDate: '2026-11-23', endDate: '2026-11-27' })
      .expect(200);
    const revisions = await history(owner, projectId);
    const batch = revisions.filter((r) => r.batchId === revisions[0]!.batchId);
    // Paged one at a time, the batch (one moment) is neither cut nor repeated.
    const paged: string[] = [];
    for (let before: string | undefined; ;) {
      const page = (
        await as(
          owner,
          http().get(
            `/projects/${projectId}/revisions?limit=1${before ? `&before=${before}` : ''}`,
          ),
        ).expect(200)
      ).body as RevisionBody[];
      if (page.length === 0) break;
      paged.push(page[0]!.id);
      before = page[0]!.id;
    }
    expect(paged).toEqual(revisions.map((r) => r.id));
    expect(batch.map((r) => r.entityId).sort()).toEqual([child.id, group.id, next.id].sort());
    // The edited task is the action's main change; the group and the pushed task came with it.
    expect(batch.filter((r) => r.primary).map((r) => r.entityId)).toEqual([child.id]);
    expect(batch.find((r) => r.entityId === child.id)!.summary).toBe(
      '“Build”: Dates Nov 2–6 → Nov 23–27',
    );
  });

  it('a move in the list records the moved task only', async () => {
    const { owner, projectId } = await setUp();
    const a = await newTask(owner, projectId, { name: 'A' });
    await newTask(owner, projectId, { name: 'B' });
    const c = await newTask(owner, projectId, { name: 'C' });
    const before = (await history(owner, projectId)).length;
    await as(owner, http().patch(`/tasks/${c.id}/move`))
      .send({ parentId: null, index: 0 })
      .expect(200);
    const revisions = await history(owner, projectId);
    expect(revisions.length).toBe(before + 1);
    expect(revisions[0]).toMatchObject({ entityId: c.id, summary: '“C”: Moved in the list' });
    expect(revisions.some((r) => r.entityId === a.id && r.action === 'update')).toBe(false);
  });

  it('restore an edit: the task is put back, and the restore is in the history', async () => {
    const { owner, projectId } = await setUp();
    const task = await newTask(owner, projectId, { name: 'Design' });
    await as(owner, http().patch(`/tasks/${task.id}`))
      .send({ name: 'Oops', startDate: '2026-12-01', endDate: '2026-12-03' })
      .expect(200);
    const created = (await history(owner, projectId)).find(
      (r) => r.entityId === task.id && r.version === 1,
    )!;
    const result = (await restore(owner, created.id).expect(201)).body as {
      version: number;
      skipped: string[];
    };
    expect(result).toMatchObject({ version: 1, skipped: [] });
    const now = (await tasksOf(owner, projectId)).find((t) => t.id === task.id)!;
    expect([now.name, now.startDate.slice(0, 10), now.endDate.slice(0, 10)]).toEqual([
      'Design',
      '2026-11-02',
      '2026-11-06',
    ]);
    const latest = (await history(owner, projectId))[0]!;
    expect(latest).toMatchObject({ entityId: task.id, version: 3 });
    expect(latest.summary).toMatch(/^Restored to version 1: Renamed “Oops” to “Design”/);
  });

  it('restore a deleted task: it comes back with its id, its group and its links', async () => {
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
    const deletion = (await history(owner, projectId)).find(
      (r) => r.entityId === doomed.id && r.action === 'delete',
    )!;
    await restore(owner, deletion.id).expect(201);
    const back = (await tasksOf(owner, projectId)).find((t) => t.id === doomed.id);
    expect(back).toMatchObject({ name: 'Doomed', parentId: group.id });
    const links = (await as(owner, http().get(`/dependencies?projectId=${projectId}`)).expect(200))
      .body as { fromTaskId: string; toTaskId: string }[];
    expect(links).toEqual([expect.objectContaining({ fromTaskId: doomed.id, toTaskId: after.id })]);
    // Its history goes on from where it was.
    const own = (await history(owner, projectId)).filter((r) => r.entityId === doomed.id);
    expect(own.map((r) => [r.version, r.action])).toEqual([
      [3, 'create'],
      [2, 'delete'],
      [1, 'create'],
    ]);
  });

  it('a restore that no longer fits is refused (400) and changes nothing', async () => {
    const { owner, projectId } = await setUp();
    const task = await newTask(owner, projectId, { name: 'Was a task' });
    await as(owner, http().patch(`/tasks/${task.id}/type`))
      .send({ type: 'group' })
      .expect(200);
    await newTask(owner, projectId, { name: 'Inside', parentId: task.id });
    const asTask = (await history(owner, projectId)).find(
      (r) => r.entityId === task.id && r.version === 1,
    )!;
    const count = (await history(owner, projectId)).length;
    const refused = await restore(owner, asTask.id);
    expect(refused.status).toBe(400);
    expect((refused.body as { message: string }).message).toMatch(/has tasks in it now/);
    expect((await history(owner, projectId)).length).toBe(count);
    expect((await tasksOf(owner, projectId)).find((t) => t.id === task.id)!.type).toBe('group');
  });

  it('events: deleted and restored; the project itself: owners only', async () => {
    const { owner, projectId, projectName } = await setUp();
    const editor = await signUp('Ed');
    await as(owner, http().post(`/projects/${projectId}/invitations`))
      .send({ email: editor.email })
      .expect(201);
    const event = (
      await as(owner, http().post('/events'))
        .send({
          projectId,
          name: 'Freeze',
          color: '#e5484d',
          startDate: '2026-11-12',
          endDate: '2026-11-13',
        })
        .expect(201)
    ).body as { id: string };
    await as(owner, http().delete(`/events/${event.id}`)).expect(204);
    await as(owner, http().patch(`/projects/${projectId}`))
      .send({ name: `${projectName} renamed` })
      .expect(200);
    const revisions = await history(editor, projectId);
    const eventGone = revisions.find((r) => r.entityId === event.id && r.action === 'delete')!;
    await restore(editor, eventGone.id).expect(201);
    const events = (await as(owner, http().get(`/events?projectId=${projectId}`)).expect(200))
      .body as { id: string; name: string }[];
    expect(events.map((e) => [e.id, e.name])).toEqual([[event.id, 'Freeze']]);

    const created = revisions.find((r) => r.entityType === 'project' && r.action === 'create')!;
    const forbidden = await restore(editor, created.id);
    expect(forbidden.status).toBe(403);
    await restore(owner, created.id).expect(201);
    const project = (await as(owner, http().get(`/projects/${projectId}`)).expect(200)).body as {
      name: string;
    };
    expect(project.name).toBe(projectName);
  });

  it('viewers read the history but restore nothing; others see nothing (404)', async () => {
    const { owner, projectId } = await setUp();
    const viewer = await signUp('Vi');
    const stranger = await signUp('Stranger');
    await as(owner, http().post(`/projects/${projectId}/invitations`))
      .send({ email: viewer.email, role: 'viewer' })
      .expect(201);
    const [first] = await history(viewer, projectId);
    expect(first).toBeDefined();
    await restore(viewer, first!.id).expect(403);
    await as(stranger, http().get(`/projects/${projectId}/revisions`)).expect(404);
    await restore(stranger, first!.id).expect(404);
    await restore(owner, randomUUID()).expect(404);
    await as(owner, http().get(`/projects/${projectId}/revisions?limit=500`)).expect(400);
  });

  it('member changes are not part of the history; paging goes back in time', async () => {
    const { owner, projectId } = await setUp();
    const ed = await signUp('Ed');
    await as(owner, http().post(`/projects/${projectId}/invitations`))
      .send({ email: ed.email })
      .expect(201);
    expect((await history(owner, projectId)).length).toBe(1);
    for (const name of ['A', 'B', 'C']) await newTask(owner, projectId, { name });
    const page1 = (
      await as(owner, http().get(`/projects/${projectId}/revisions?limit=2`)).expect(200)
    ).body as RevisionBody[];
    expect(page1.map((r) => r.summary)).toEqual(['Added task “C”', 'Added task “B”']);
    const page2 = (
      await as(
        owner,
        http().get(`/projects/${projectId}/revisions?limit=2&before=${page1[1]!.id}`),
      ).expect(200)
    ).body as RevisionBody[];
    expect(page2.map((r) => r.summary)).toEqual([
      'Added task “A”',
      expect.stringMatching(/^Created/),
    ]);
  });
});
