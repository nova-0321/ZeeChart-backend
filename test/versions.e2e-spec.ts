import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { deleteTestAccounts } from './cleanup.js';
import { createValidationPipe } from '../src/common/validation.js';

// Versions of a whole project: v1 when it is made, auto ones as it changes (at most one every 10
// minutes), "Save a version now", stars, and restoring a whole version (undoable).

interface Account {
  token: string;
  id: string;
  email: string;
}
interface VersionSummary {
  id: string;
  number: number;
  kind: string;
  starred: boolean;
  tasks: number;
  events: number;
  createdBy: { name: string } | null;
}
interface TaskBody {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
}

describe('Versions (e2e)', () => {
  let app: INestApplication;
  let db: DataSource;
  const http = () => request(app.getHttpServer());
  const as = (account: Account, call: request.Test) =>
    call.set('Authorization', `Bearer ${account.token}`);

  const signUp = async (name: string): Promise<Account> => {
    const body = (
      await http()
        .post('/auth/signup')
        .send({ name, email: `zzver-${randomUUID()}@example.com`, password: 'pass-word-1' })
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
    await deleteTestAccounts(app, 'zzver-');
    await app.close();
  });

  const setUp = async () => {
    const owner = await signUp('Olive');
    const project = (
      await as(owner, http().post('/projects'))
        .send({ name: `zzver ${randomUUID()}` })
        .expect(201)
    ).body as { id: string };
    return { owner, projectId: project.id };
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
  const versions = async (who: Account, projectId: string) =>
    (await as(who, http().get(`/projects/${projectId}/versions`)).expect(200))
      .body as VersionSummary[];
  const tasksOf = async (who: Account, projectId: string) =>
    (await as(who, http().get(`/tasks?projectId=${projectId}`)).expect(200)).body as TaskBody[];
  /** Makes the newest version look older than 10 minutes (the next change saves an auto one). */
  const ageVersions = (projectId: string) =>
    db.query(
      `UPDATE "project_versions" SET "createdAt" = "createdAt" - interval '1 hour' WHERE "projectId" = $1`,
      [projectId],
    );

  it('a new project has v1; its first change is kept at once (v2), the next soon after are not; "Save a version now"', async () => {
    const { owner, projectId } = await setUp();
    expect(await versions(owner, projectId)).toEqual([
      expect.objectContaining({
        number: 1,
        kind: 'auto',
        tasks: 0,
        createdBy: { id: owner.id, name: 'Olive' },
      }),
    ]);
    await newTask(owner, projectId, { name: 'A' });
    await newTask(owner, projectId, { name: 'B' });
    expect((await versions(owner, projectId)).map((v) => [v.number, v.tasks])).toEqual([
      [2, 1],
      [1, 0],
    ]);
    const saved = (await as(owner, http().post(`/projects/${projectId}/versions`)).expect(201))
      .body as VersionSummary;
    expect(saved).toMatchObject({ number: 3, kind: 'manual', tasks: 2 });
    expect((await versions(owner, projectId)).map((v) => v.number)).toEqual([3, 2, 1]);
  });

  it('an auto version after a change, when the last one is older than 10 minutes; one, not two', async () => {
    const { owner, projectId } = await setUp();
    await ageVersions(projectId);
    await newTask(owner, projectId, { name: 'A' });
    await newTask(owner, projectId, { name: 'B' });
    expect((await versions(owner, projectId)).map((v) => [v.number, v.kind, v.tasks])).toEqual([
      [2, 'auto', 1],
      [1, 'auto', 0],
    ]);
    // B came after v2: the next change, 10 minutes on, saves the project with it (v3).
    await ageVersions(projectId);
    const [task] = await tasksOf(owner, projectId);
    await as(owner, http().patch(`/tasks/${task!.id}`))
      .send({ name: task!.name })
      .expect(200);
    expect((await versions(owner, projectId)).map((v) => [v.number, v.tasks])[0]).toEqual([3, 2]);
    // Nothing differs from v3 any more: none.
    await ageVersions(projectId);
    await as(owner, http().patch(`/tasks/${task!.id}`))
      .send({ name: task!.name })
      .expect(200);
    expect((await versions(owner, projectId)).length).toBe(3);
  });

  it('restore a version: the project as it was (ids, groups, order, links, events); undoable', async () => {
    const { owner, projectId } = await setUp();
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
    await as(owner, http().post('/events'))
      .send({
        projectId,
        name: 'Freeze',
        color: '#e5484d',
        startDate: '2026-11-12',
        endDate: '2026-11-12',
      })
      .expect(201);
    const full = (await as(owner, http().post(`/projects/${projectId}/versions`)).expect(201))
      .body as VersionSummary;
    const before = await tasksOf(owner, projectId);

    // Back to v1 (empty): everything goes, and what was there is kept first.
    const v1 = (await versions(owner, projectId)).find((v) => v.number === 1)!;
    const result = (await as(owner, http().post(`/versions/${v1.id}/restore`)).expect(201))
      .body as { version: number; savedAs: number | null };
    // The full state was already a version (just saved): not saved again.
    expect(result).toEqual({ version: 1, savedAs: null });
    expect(await tasksOf(owner, projectId)).toEqual([]);

    // And back to the full one.
    await as(owner, http().post(`/versions/${full.id}/restore`)).expect(201);
    const after = await tasksOf(owner, projectId);
    const shape = (tasks: TaskBody[]) =>
      tasks.map((t) => [t.id, t.name, t.parentId, t.order]).sort();
    expect(shape(after)).toEqual(shape(before));
    const links = (await as(owner, http().get(`/dependencies?projectId=${projectId}`)).expect(200))
      .body as { fromTaskId: string; toTaskId: string }[];
    expect(links.map((l) => [l.fromTaskId, l.toTaskId])).toEqual([[child.id, ship.id]]);
    const events = (await as(owner, http().get(`/events?projectId=${projectId}`)).expect(200))
      .body as { name: string }[];
    expect(events.map((e) => e.name)).toEqual(['Freeze']);

    // The per-item history says what the restores did.
    const history = (await as(owner, http().get(`/projects/${projectId}/revisions`)).expect(200))
      .body as { summary: string }[];
    expect(history.some((r) => r.summary.startsWith('Restored version v1: Deleted task'))).toBe(
      true,
    );
  });

  it('the state a restore replaces is kept as a version (before-restore) when no version has it', async () => {
    const { owner, projectId } = await setUp();
    await newTask(owner, projectId, { name: 'Saved' }); // v2 (a new project's first change)
    await newTask(owner, projectId, { name: 'Unsaved work' });
    const v1 = (await versions(owner, projectId)).find((v) => v.number === 1)!;
    const result = (await as(owner, http().post(`/versions/${v1.id}/restore`)).expect(201))
      .body as { savedAs: number | null };
    expect(result.savedAs).toBe(3);
    const list = await versions(owner, projectId);
    expect(list[0]).toMatchObject({ number: 3, kind: 'before-restore', tasks: 2 });
    await as(owner, http().post(`/versions/${list[0]!.id}/restore`)).expect(201);
    expect((await tasksOf(owner, projectId)).map((t) => t.name).sort()).toEqual([
      'Saved',
      'Unsaved work',
    ]);
  });

  it('stars; a version with its contents; roles (viewer reads, editors save and restore)', async () => {
    const { owner, projectId } = await setUp();
    const viewer = await signUp('Vi');
    const stranger = await signUp('Stranger');
    await as(owner, http().post(`/projects/${projectId}/invitations`))
      .send({ email: viewer.email, role: 'viewer' })
      .expect(201);
    await newTask(owner, projectId, { name: 'A' });
    const v1 = (await versions(viewer, projectId)).find((v) => v.number === 1);
    const starred = (
      await as(owner, http().patch(`/versions/${v1!.id}`))
        .send({ starred: true })
        .expect(200)
    ).body as VersionSummary & { content: { tasks: unknown[]; project: { id: string } } };
    expect(starred.starred).toBe(true);
    expect(starred.content.project.id).toBe(projectId);
    const one = (await as(viewer, http().get(`/versions/${v1!.id}`)).expect(200)).body as {
      content: { tasks: unknown[] };
    };
    expect(one.content.tasks).toEqual([]);
    await as(viewer, http().post(`/projects/${projectId}/versions`)).expect(403);
    await as(viewer, http().post(`/versions/${v1!.id}/restore`)).expect(403);
    await as(viewer, http().patch(`/versions/${v1!.id}`))
      .send({ starred: false })
      .expect(403);
    await as(stranger, http().get(`/projects/${projectId}/versions`)).expect(404);
    await as(stranger, http().get(`/versions/${v1!.id}`)).expect(404);
    await as(owner, http().patch(`/versions/${v1!.id}`))
      .send({ starred: 'yes' })
      .expect(400);
  });

  it('the list comes 50 at a time, newest first; `before` gives the next page (#59)', async () => {
    const { owner, projectId } = await setUp();
    const task = await newTask(owner, projectId, { name: 'Draft 0' });
    // A version saved by hand after each change: 55 of them, besides v1 and v2.
    for (let n = 1; n <= 55; n++) {
      await as(owner, http().patch(`/tasks/${task.id}`))
        .send({ name: `Draft ${n}` })
        .expect(200);
      await as(owner, http().post(`/projects/${projectId}/versions`)).expect(201);
    }
    const page = async (query: string) =>
      (await as(owner, http().get(`/projects/${projectId}/versions?${query}`)).expect(200))
        .body as VersionSummary[];

    const first = await versions(owner, projectId);
    expect(first).toHaveLength(50);
    const numbers = first.map((v) => v.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    // The next page goes on with the older ones: the two pages are the whole list (with the oldest
    // manual ones pruned, numbers skip), in order, nothing twice.
    const second = await page(`before=${first.at(-1)!.id}`);
    const all = await page('limit=100');
    expect([...first, ...second]).toEqual(all);
    expect(second.at(-1)!.number).toBe(1);

    const two = await page('limit=2');
    expect(two.map((v) => v.number)).toEqual(numbers.slice(0, 2));
    expect(await page(`before=${second.at(-1)!.id}`)).toEqual([]);
    await as(owner, http().get(`/projects/${projectId}/versions?limit=101`)).expect(400);
    await as(owner, http().get(`/projects/${projectId}/versions?before=nope`)).expect(400);
  });
});
