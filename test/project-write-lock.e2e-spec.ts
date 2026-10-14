import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, type QueryRunner } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/validation.js';
import { deleteTestAccounts } from './cleanup.js';

// Writes to one project run one after another across server instances (ProjectWriteLock): the
// conflict check (#21), the link and task-parent cycle checks, task order numbering, and the
// history each write records. Two separate INestApplications here, sharing the same database, stand
// in for two instances: an in-memory queue in appA cannot see what appB is doing, so only the
// database lock can serialize them.

/** One signed-in client against one app instance: the handful of calls these tests need. */
interface Api {
  post: (path: string, body: object) => request.Test;
  patch: (path: string, body: object) => request.Test;
  delete: (path: string) => request.Test;
  get: (path: string) => request.Test;
}
const api = (app: INestApplication, token: string): Api => ({
  post: (path, body) =>
    request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body),
  patch: (path, body) =>
    request(app.getHttpServer()).patch(path).set('Authorization', `Bearer ${token}`).send(body),
  delete: (path) =>
    request(app.getHttpServer()).delete(path).set('Authorization', `Bearer ${token}`),
  get: (path) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`),
});
/** Sends the request now (supertest waits until it is awaited), so several can be in flight. */
const send = (call: request.Test): Promise<request.Response> => call.then((response) => response);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// A write that waits for nothing takes about 0.1 s here; a request still running after 0.6 s is
// waiting for the lock.
const NORMAL_MS = 600;
/** Whether the call has finished (either way) within `windowMs`. */
const settledYet = (call: Promise<unknown>, windowMs = NORMAL_MS) =>
  Promise.race([
    call.then(
      () => true,
      () => true,
    ),
    sleep(windowMs).then(() => false),
  ]);
/** Whether every call is still running after a normal write's time and a margin. */
const allStillWaiting = async (...calls: Promise<unknown>[]) => {
  await sleep(NORMAL_MS);
  const settled = await Promise.all(calls.map((call) => settledYet(call, 0)));
  return settled.every((done) => !done);
};

describe('Cross-instance project write lock (e2e)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let dbA: DataSource;
  const start = async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
    return app;
  };

  beforeAll(async () => {
    [appA, appB] = await Promise.all([start(), start()]);
    dbA = appA.get(DataSource);
  });

  afterAll(async () => {
    await deleteTestAccounts(appA, 'zzlock-');
    await Promise.all([appA.close(), appB.close()]);
  });

  /** Project locks the test takes itself (on its own connection, not through either app's lock), let go after each test. */
  const holders: QueryRunner[] = [];
  const holdLock = async (projectId: string) => {
    const holder = dbA.createQueryRunner();
    holders.push(holder);
    await holder.startTransaction();
    await holder.query(`SELECT pg_advisory_xact_lock(hashtext('project-writes'), hashtext($1))`, [
      projectId,
    ]);
    return holder;
  };
  const letGo = async (holder: QueryRunner) => {
    await holder.rollbackTransaction();
    await holder.release();
  };
  afterEach(async () => {
    // A test that failed before letting go would otherwise keep its lock (and the apps waiting).
    for (const holder of holders.splice(0)) {
      if (holder.isReleased) continue;
      if (holder.isTransactionActive) await holder.rollbackTransaction().catch(() => undefined);
      await holder.release();
    }
  });

  const signUp = async (name: string) => {
    const email = `zzlock-${randomUUID()}@example.com`;
    const body = (
      await request(appA.getHttpServer())
        .post('/auth/signup')
        .send({ name, email, password: 'pass-word-1' })
        .expect(201)
    ).body as { accessToken: string; user: { id: string } };
    return { token: body.accessToken, id: body.user.id, email };
  };

  /** A signed-in owner (via appA) with a project and two top-level tasks, no link between them. */
  const setUp = async () => {
    const owner = await signUp('Lock');
    const [apiA, apiB] = [api(appA, owner.token), api(appB, owner.token)];
    const project = (await apiA.post('/projects', { name: `Lock ${randomUUID()}` }).expect(201))
      .body as { id: string };
    const task = async (name: string, extra: object = {}) =>
      (
        await apiA
          .post('/tasks', {
            projectId: project.id,
            name,
            color: '#2a78d6',
            startDate: '2026-11-02',
            endDate: '2026-11-03',
            ...extra,
          })
          .expect(201)
      ).body as { id: string; version: number };
    const [x, y] = [await task('X'), await task('Y')];
    return { projectId: project.id, x, y, apiA, apiB, task };
  };

  it('links A→B and B→A on two instances: one is created, the other refused, never a cycle', async () => {
    const { projectId, x, y, apiA, apiB } = await setUp();
    const holder = await holdLock(projectId);
    const fromA = send(apiA.post('/dependencies', { fromTaskId: x.id, toTaskId: y.id }));
    const fromB = send(apiB.post('/dependencies', { fromTaskId: y.id, toTaskId: x.id }));
    expect(await allStillWaiting(fromA, fromB)).toBe(true);
    await letGo(holder);

    const [resultA, resultB] = await Promise.all([fromA, fromB]);
    expect([resultA.status, resultB.status].sort()).toEqual([201, 400]);
    const refused = resultA.status === 400 ? resultA : resultB;
    expect((refused.body as { message: string }).message).toBe(
      'That link would make the tasks wait for each other',
    );
    const links = (await apiA.get(`/dependencies?projectId=${projectId}`).expect(200))
      .body as unknown[];
    expect(links).toHaveLength(1);
  });

  it('a write to another project does not wait for a locked one, on the same instance', async () => {
    const [p1, p2] = await Promise.all([setUp(), setUp()]);
    const holder = await holdLock(p1.projectId);
    const forP1 = send(p1.apiA.post('/dependencies', { fromTaskId: p1.x.id, toTaskId: p1.y.id }));
    const forP2 = await p2.apiA.post('/dependencies', { fromTaskId: p2.x.id, toTaskId: p2.y.id });
    expect(forP2.status).toBe(201);
    expect(await settledYet(forP1, 0)).toBe(false);
    await letGo(holder);
    expect((await forP1).status).toBe(201);
  });

  it('a task reparent waits for the same project lock as a link create', async () => {
    const { projectId, x, y, apiA, apiB } = await setUp();
    const holder = await holdLock(projectId);
    const link = send(apiA.post('/dependencies', { fromTaskId: x.id, toTaskId: y.id }));
    const reparent = send(apiB.patch(`/tasks/${y.id}/parent`, { parentId: x.id }));
    expect(await allStillWaiting(link, reparent)).toBe(true);
    await letGo(holder);
    // What matters is that both waited; their outcomes don't depend on which went first (x is a
    // plain task, so it can't take y in either order).
    expect((await link).status).toBe(201);
    const refused = await reparent;
    expect(refused.status).toBe(400);
    expect((refused.body as { message: string }).message).toBe('Parent must be a group');
  });

  /** Every task of the project, grouped by level (parentId, '' for the top level). */
  const levelsOf = async (apiX: Api, projectId: string) => {
    const tasks = (await apiX.get(`/tasks?projectId=${projectId}`).expect(200)).body as {
      parentId: string | null;
      order: number;
    }[];
    const byLevel = new Map<string, number[]>();
    for (const task of tasks) {
      const key = task.parentId ?? '';
      byLevel.set(key, [...(byLevel.get(key) ?? []), task.order]);
    }
    return byLevel;
  };
  /** No level has two tasks claiming the same place. */
  const noDuplicateOrders = (byLevel: Map<string, number[]>) =>
    [...byLevel.values()].every((orders) => new Set(orders).size === orders.length);
  const topLevelTask = (apiX: Api, projectId: string, name: string) =>
    apiX.post('/tasks', {
      projectId,
      name,
      color: '#2a78d6',
      startDate: '2026-11-02',
      endDate: '2026-11-03',
    });

  it('two creates on two instances never give two tasks the same order', async () => {
    const { projectId, apiA, apiB } = await setUp();
    const holder = await holdLock(projectId);
    // No order sent: each takes one past the highest it reads.
    const fromA = send(topLevelTask(apiA, projectId, 'A3'));
    const fromB = send(topLevelTask(apiB, projectId, 'B3'));
    expect(await allStillWaiting(fromA, fromB)).toBe(true);
    await letGo(holder);

    expect([(await fromA).status, (await fromB).status]).toEqual([201, 201]);
    expect(noDuplicateOrders(await levelsOf(apiA, projectId))).toBe(true);
  });

  it("a group delete's renumbering and a create on the same list never give two tasks the same order", async () => {
    const { projectId, apiA, apiB, task } = await setUp();
    // X 1, Y 2, the group 3, its tasks 1 to 3 inside it. Deleting the group puts its tasks in its
    // place and numbers the top level 1 to 5, while a create takes one past the highest order it
    // read: 4 if it read before the delete, which the delete may have just given to a task.
    const group = await task('Group', { type: 'group' });
    for (const order of [1, 2, 3]) await task(`In ${order}`, { parentId: group.id, order });

    const holder = await holdLock(projectId);
    const deleteGroup = send(apiA.delete(`/tasks/${group.id}`));
    const createTop = send(topLevelTask(apiB, projectId, 'NewTop'));
    expect(await allStillWaiting(deleteGroup, createTop)).toBe(true);
    await letGo(holder);

    expect([(await deleteGroup).status, (await createTop).status]).toEqual([204, 201]);
    const levels = await levelsOf(apiA, projectId);
    expect(levels.get('')).toHaveLength(6);
    expect(noDuplicateOrders(levels)).toBe(true);
  });

  /** A second person, an editor of the project, signed in on appB. */
  const editorOnB = async (apiA: Api, projectId: string) => {
    const bob = await signUp('Bob');
    await apiA.post(`/projects/${projectId}/invitations`, { email: bob.email }).expect(201);
    return api(appB, bob.token);
  };

  it('two people saving the same field from the same version on two instances: one is refused (409), never silently overwritten', async () => {
    const { projectId, x: task, apiA } = await setUp();
    // Two people: a second save by the same person is never a conflict.
    const bobOnB = await editorOnB(apiA, projectId);

    const holder = await holdLock(projectId);
    const fromOwner = send(
      apiA.patch(`/tasks/${task.id}`, { name: 'Owner edit' }).set('If-Match', String(task.version)),
    );
    const fromBob = send(
      bobOnB.patch(`/tasks/${task.id}`, { name: 'Bob edit' }).set('If-Match', String(task.version)),
    );
    expect(await allStillWaiting(fromOwner, fromBob)).toBe(true);
    await letGo(holder);

    const [resultOwner, resultBob] = await Promise.all([fromOwner, fromBob]);
    expect([resultOwner.status, resultBob.status].sort()).toEqual([200, 409]);
    const winner = resultOwner.status === 200 ? 'Owner edit' : 'Bob edit';
    const now = (await apiA.get(`/tasks?projectId=${projectId}`).expect(200)).body as {
      id: string;
      name: string;
    }[];
    expect(now.find((t) => t.id === task.id)!.name).toBe(winner);
  });

  it('two people changing different fields at once on two instances: each revision is theirs alone', async () => {
    const { projectId, x: task, apiA } = await setUp();
    const bobOnB = await editorOnB(apiA, projectId);

    const holder = await holdLock(projectId);
    const rename = send(apiA.patch(`/tasks/${task.id}`, { name: 'Renamed' }));
    const recolor = send(bobOnB.patch(`/tasks/${task.id}`, { color: '#e5484d' }));
    expect(await allStillWaiting(rename, recolor)).toBe(true);
    await letGo(holder);
    expect([(await rename).status, (await recolor).status]).toEqual([200, 200]);

    const revisions = (
      (await apiA.get(`/projects/${projectId}/revisions`).expect(200)).body as {
        entityId: string;
        action: string;
        version: number;
        changedBy: { name: string } | null;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }[]
    ).filter((r) => r.entityId === task.id && r.action === 'update');
    const changed = (r: (typeof revisions)[number]) =>
      ['name', 'color'].filter((field) => r.before?.[field] !== r.after?.[field]);
    // Each one's snapshots saw only its own change, and the two took the next two versions.
    expect(
      revisions
        .map((r) => ({ by: r.changedBy?.name, changed: changed(r), version: r.version }))
        .sort((a, b) => a.version - b.version)
        .map(({ by, changed }) => ({ by, changed })),
    ).toEqual(
      expect.arrayContaining([
        { by: 'Lock', changed: ['name'] },
        { by: 'Bob', changed: ['color'] },
      ]),
    );
    expect(revisions).toHaveLength(2);
    expect(revisions.map((r) => r.version).sort()).toEqual([2, 3]);
  });

  // More writes at once than the pool has connections (10). A write waiting for the lock holds a
  // connection, so the one holding it must need no other: one that did hung every write for good
  // (the first version of the lock). One instance is enough.
  const BURST = 15;
  /** The status of each call, or null when they don't all finish within `ms`. */
  const statusesWithin = (calls: request.Test[], ms: number) =>
    Promise.race([
      Promise.all(calls.map(async (call) => (await call).status)),
      sleep(ms).then(() => null),
    ]);

  it('a burst of writes to one project, more than the connection pool holds, all finish', async () => {
    const { x, apiA } = await setUp();
    const statuses = await statusesWithin(
      Array.from({ length: BURST }, (_, i) => apiA.patch(`/tasks/${x.id}`, { progress: i })),
      15_000,
    );
    expect(statuses).toEqual(Array(BURST).fill(200));
  });

  it('a burst of writes to as many different projects all finish', async () => {
    const owner = await signUp('Burst');
    const apiA = api(appA, owner.token);
    const taskIds: string[] = [];
    for (let i = 0; i < BURST; i++) {
      const project = (await apiA.post('/projects', { name: `Burst ${randomUUID()}` }).expect(201))
        .body as { id: string };
      taskIds.push(
        ((await topLevelTask(apiA, project.id, 'T').expect(201)).body as { id: string }).id,
      );
    }
    const statuses = await statusesWithin(
      taskIds.map((id, i) => apiA.patch(`/tasks/${id}`, { progress: i })),
      15_000,
    );
    expect(statuses).toEqual(Array(BURST).fill(200));
  });

  it('writes queued behind a locked project leave other projects on the same instance free', async () => {
    const [p, q] = await Promise.all([setUp(), setUp()]);
    const holder = await holdLock(p.projectId);
    // More than the pool holds (10): without the in-memory queue in front, these would each take a
    // connection while they wait, and q's write would wait for one.
    const queued = Array.from({ length: 12 }, (_, i) =>
      send(p.apiA.patch(`/tasks/${p.x.id}`, { progress: i })),
    );
    expect(await allStillWaiting(...queued)).toBe(true);
    const forQ = send(q.apiA.patch(`/tasks/${q.x.id}`, { progress: 50 }));
    expect(await settledYet(forQ, 5_000)).toBe(true);
    expect((await forQ).status).toBe(200);
    await letGo(holder);
    expect((await Promise.all(queued)).map((r) => r.status)).toEqual(Array(12).fill(200));
  });

  it('a write refused inside the lock lets it go: the next writes to the project go through', async () => {
    const { x, apiA, apiB } = await setUp();
    await apiA.post('/dependencies', { fromTaskId: x.id, toTaskId: x.id }).expect(400);
    // On the same instance (its in-memory queue) and on the other one (the database lock).
    const sameInstance = send(apiA.patch(`/tasks/${x.id}`, { progress: 10 }));
    expect(await settledYet(sameInstance, 5_000)).toBe(true);
    const otherInstance = send(apiB.patch(`/tasks/${x.id}`, { progress: 20 }));
    expect(await settledYet(otherInstance, 5_000)).toBe(true);
    expect([(await sameInstance).status, (await otherInstance).status]).toEqual([200, 200]);
  });

  it('a project id sent in capitals takes the same lock', async () => {
    const { projectId, apiA, apiB } = await setUp();
    const holder = await holdLock(projectId);
    const shouting = send(topLevelTask(apiB, projectId.toUpperCase(), 'Upper'));
    const plain = send(topLevelTask(apiA, projectId, 'Lower'));
    expect(await allStillWaiting(shouting, plain)).toBe(true);
    await letGo(holder);
    expect([(await shouting).status, (await plain).status]).toEqual([201, 201]);
    expect(noDuplicateOrders(await levelsOf(apiA, projectId))).toBe(true);
  });
});
