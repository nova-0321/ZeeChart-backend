import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/validation.js';
import { RevisionsService } from '../src/revisions/revisions.service.js';
import { VersionsService } from '../src/revisions/versions.service.js';
import { TaskScheduler } from '../src/tasks/scheduling/task-scheduler.service.js';
import { TaskService } from '../src/tasks/task.service.js';
import { deleteTestAccounts } from './cleanup.js';

// A write is one transaction (RequestTransaction): its changes and its history are saved together
// or not at all. Each test makes one step fail after earlier steps already wrote, and checks that
// nothing of the write is left.

interface TaskBody {
  id: string;
  name: string;
  version: number;
  parentId: string | null;
}

describe('A write and its history: all or nothing (e2e)', () => {
  let app: INestApplication;
  let token = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
    const signUp = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ name: 'Tx', email: `zztx-${randomUUID()}@example.com`, password: 'pass-word-1' })
      .expect(201);
    token = (signUp.body as { accessToken: string }).accessToken;
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await deleteTestAccounts(app, 'zztx-');
    await app.close();
  });

  const as = (call: request.Test) => call.set('Authorization', `Bearer ${token}`);
  const http = () => request(app.getHttpServer());
  const newProject = async () =>
    (
      (
        await as(http().post('/projects'))
          .send({ name: `Tx ${randomUUID()}` })
          .expect(201)
      ).body as { id: string }
    ).id;
  const newTask = async (projectId: string, name: string, extra: object = {}) =>
    (
      await as(http().post('/tasks'))
        .send({
          projectId,
          name,
          color: '#2a78d6',
          startDate: '2026-11-02',
          endDate: '2026-11-06',
          ...extra,
        })
        .expect(201)
    ).body as TaskBody;
  const tasksOf = async (projectId: string) =>
    (await as(http().get(`/tasks?projectId=${projectId}`)).expect(200)).body as TaskBody[];
  const historyOf = async (projectId: string) =>
    (
      (await as(http().get(`/projects/${projectId}/revisions?limit=100`)).expect(200))
        .body as unknown[]
    ).length;

  it('a change whose history cannot be recorded is not saved: no change, no new version, no revision', async () => {
    const projectId = await newProject();
    const task = await newTask(projectId, 'Design');
    const before = await historyOf(projectId);
    vi.spyOn(app.get(RevisionsService), 'record').mockRejectedValueOnce(new Error('history down'));

    await as(http().patch(`/tasks/${task.id}`))
      .send({ name: 'Renamed' })
      .expect(500);

    const [now] = (await tasksOf(projectId)).filter((t) => t.id === task.id);
    expect(now).toMatchObject({ name: 'Design', version: task.version });
    expect(await historyOf(projectId)).toBe(before);
    // And the next change goes through, recorded as usual.
    await as(http().patch(`/tasks/${task.id}`))
      .send({ name: 'Renamed' })
      .expect(200);
    expect(await historyOf(projectId)).toBe(before + 1);
  });

  it('a link saved and then not applied (the reschedule fails) is not left behind', async () => {
    const projectId = await newProject();
    const [a, b] = [await newTask(projectId, 'A'), await newTask(projectId, 'B')];
    vi.spyOn(app.get(TaskScheduler), 'rescheduleFrom').mockRejectedValueOnce(new Error('boom'));

    await as(http().post('/dependencies')).send({ fromTaskId: a.id, toTaskId: b.id }).expect(500);

    const links = (await as(http().get(`/dependencies?projectId=${projectId}`)).expect(200))
      .body as unknown[];
    expect(links).toEqual([]);
  });

  it('a crash between saving a link and applying it leaves no link: the database rolls the write back', async () => {
    const projectId = await newProject();
    const [a, b] = [await newTask(projectId, 'A'), await newTask(projectId, 'B')];
    // The process "dies" right after the link is saved: nothing after that point ever runs, so no
    // clean-up code can help. Then its database connection goes, as it does when a process dies.
    let reached!: () => void;
    const atReschedule = new Promise<void>((resolve) => (reached = resolve));
    vi.spyOn(app.get(TaskScheduler), 'rescheduleFrom').mockImplementationOnce(() => {
      reached();
      return new Promise<void>(() => undefined);
    });
    const pending = as(http().post('/dependencies'))
      .send({ fromTaskId: a.id, toTaskId: b.id })
      .timeout(5_000)
      .then(
        () => undefined,
        () => undefined,
      );
    await atReschedule;
    // The connection of the write: the one holding the project's lock.
    const killed = await app.get(DataSource).query<unknown[]>(
      `SELECT pg_terminate_backend("pid") FROM pg_locks
        WHERE "locktype" = 'advisory' AND "objsubid" = 2
          AND "classid"::bigint = (hashtext('project-writes')::bigint + 4294967296) % 4294967296
          AND "objid"::bigint = (hashtext($1)::bigint + 4294967296) % 4294967296`,
      [projectId],
    );
    expect(killed).toHaveLength(1);
    await pending;

    const links = (await as(http().get(`/dependencies?projectId=${projectId}`)).expect(200))
      .body as unknown[];
    expect(links).toEqual([]);
  });

  it('a restore refused after its first step leaves the task as it was (back in its group)', async () => {
    const projectId = await newProject();
    const group = await newTask(projectId, 'Group', { type: 'group' });
    const task = await newTask(projectId, 'T');
    await as(http().patch(`/tasks/${task.id}/parent`))
      .send({ parentId: group.id })
      .expect(200);
    // Restoring its first revision puts it back at the top level (step 1), then updates its
    // fields (step 2), which fails here.
    const revisions = (
      await as(http().get(`/projects/${projectId}/revisions?limit=100`)).expect(200)
    ).body as { id: string; entityId: string; action: string }[];
    const created = revisions.find((r) => r.entityId === task.id && r.action === 'create')!;
    vi.spyOn(app.get(TaskService), 'update').mockRejectedValueOnce(new Error('refused'));

    await as(http().post(`/revisions/${created.id}/restore`)).expect(500);

    const [now] = (await tasksOf(projectId)).filter((t) => t.id === task.id);
    expect(now.parentId).toBe(group.id);
  });

  it('a version copy that fails while filling the new project leaves no project', async () => {
    const projectId = await newProject();
    await newTask(projectId, 'T');
    // 200: the version made by that change already holds this (no copy of it is made).
    const version = (await as(http().post(`/projects/${projectId}/versions`)).expect(200)).body as {
      id: string;
    };
    const count = async () =>
      ((await as(http().get('/projects')).expect(200)).body as unknown[]).length;
    const before = await count();
    vi.spyOn(
      app.get(VersionsService) as unknown as { fill: () => Promise<void> },
      'fill',
    ).mockRejectedValueOnce(new Error('disk full'));

    await as(http().post(`/versions/${version.id}/copy`)).expect(500);

    expect(await count()).toBe(before);
  });
});
