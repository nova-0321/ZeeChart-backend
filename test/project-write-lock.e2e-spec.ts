import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, type QueryRunner } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/validation.js';
import { deleteTestAccounts } from './cleanup.js';

// #50: the dependency and task-parent cycle checks, and task order numbering (create's "next"
// order, and a deleted group's renumbering of the list it leaves its children in - the client's
// own words were "order numbering", not only the cycle checks the GitHub issue's text singles
// out), used to be serialized only by RevisionInterceptor's in-memory per-project queue, which
// holds only within one server instance. Two separate INestApplications here, sharing the same
// database, stand in for two instances: the in-memory queue in appA cannot see what appB is doing,
// so only a real, database-level lock (withProjectWriteLock) can still serialize them.

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
      ).body as { id: string };
    const [x, y] = [await task('X'), await task('Y')];
    return { projectId: project.id, x, y, apiA, apiB, task };
  };

  /** Holds `pg_advisory_xact_lock('writes:<projectId>')` on its own connection until released. */
  const holdLock = async (db: DataSource, projectId: string): Promise<QueryRunner> => {
    const qr = db.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    await qr.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`writes:${projectId}`]);
    return qr;
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // A genuinely unblocked POST /dependencies takes ~110ms here (several sequential queries: load
  // both tasks, the lock statement itself, the ancestor and cycle checks, the schedulability check,
  // the insert, the reschedule). The windows below are chosen with that measured baseline in mind:
  // generous enough that normal processing time is never mistaken for being blocked.
  const NORMAL_MS = 600;
  /** Whether a promise has already settled, without ever rejecting this check itself. */
  const settledYet = async (promise: Promise<unknown>, windowMs = NORMAL_MS) => {
    const sentinel = Symbol('pending');
    const result = await Promise.race([
      promise.catch(() => sentinel),
      sleep(windowMs).then(() => sentinel),
    ]);
    return result !== sentinel;
  };

  it('blocks a second instance creating a link for the same project until the first finishes, and the loser is correctly refused (no cycle gets through)', async () => {
    const { projectId, x, y, apiA, apiB } = await setUp();

    // Held externally first: both app instances' writes must queue up behind this, proving the
    // lock is a real, externally-visible database lock and not merely in-process.
    const holder = await holdLock(dbA, projectId);
    const fromA = apiA.post('/dependencies', { fromTaskId: x.id, toTaskId: y.id });
    const fromB = apiB.post('/dependencies', { fromTaskId: y.id, toTaskId: x.id });

    expect(await settledYet(fromA)).toBe(false);
    expect(await settledYet(fromB)).toBe(false);

    await holder.commitTransaction();
    await holder.release();

    const [resultA, resultB] = await Promise.all([fromA, fromB]);
    // Exactly one of the two mutually-cyclic links is created; the other is refused once the
    // winner's link is visible to it - never both (that would be a two-node cycle).
    const statuses = [resultA.status, resultB.status].sort();
    expect(statuses).toEqual([201, 400]);
    const refused = resultA.status === 400 ? resultA : resultB;
    expect((refused.body as { message: string }).message).toBe(
      'That link would make the tasks wait for each other',
    );

    const links = (await apiA.get(`/dependencies?projectId=${projectId}`).expect(200)).body as {
      fromTaskId: string;
      toTaskId: string;
    }[];
    expect(links).toHaveLength(1);
  });

  it('does not serialize writes to different projects against each other', async () => {
    const [p1, p2] = await Promise.all([setUp(), setUp()]);
    const holder = await holdLock(dbA, p1.projectId); // only locks p1's key
    const forP1 = p1.apiA.post('/dependencies', { fromTaskId: p1.x.id, toTaskId: p1.y.id });
    const forP2 = p2.apiB.post('/dependencies', { fromTaskId: p2.x.id, toTaskId: p2.y.id });

    expect(await settledYet(forP1)).toBe(false); // blocked: p1's key is held
    expect(await settledYet(forP2)).toBe(true); // resolves well within NORMAL_MS: unaffected

    await holder.commitTransaction();
    await holder.release();
    await expect(forP1).resolves.toMatchObject({ status: 201 });
  });

  it('serializes a task reparent against a link create on the same project the same way', async () => {
    const { projectId, x, y, apiA, apiB } = await setUp();
    // x becomes a group holding y, through DependencyService's own path is unrelated here - use
    // the dependency create (link x->y) racing a reparent of y under x, which would itself be
    // refused as "A group cannot be linked to a task inside it" once the other side commits first,
    // proving the two different operations share the same per-project lock, not two unrelated ones.
    const holder = await holdLock(dbA, projectId);
    const link = apiA.post('/dependencies', { fromTaskId: x.id, toTaskId: y.id });
    const reparent = apiB.patch(`/tasks/${y.id}/parent`, { parentId: x.id });

    expect(await settledYet(link)).toBe(false);
    expect(await settledYet(reparent)).toBe(false);

    await holder.commitTransaction();
    await holder.release();
    await Promise.all([link, reparent]); // both settle (one of these may itself fail for other
    // business reasons - the point already proven above is that neither ran concurrently with the
    // holder; this just confirms the same lock key is shared across the two operations).
  });

  /** Every task of the project, grouped by level (parentId, '' for the top level). */
  const levelsOf = async (apiA: Api, projectId: string) => {
    const tasks = (await apiA.get(`/tasks?projectId=${projectId}`).expect(200)).body as {
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
  /** No level in the map has two tasks silently claiming the same order. */
  const noDuplicateOrders = (byLevel: Map<string, number[]>) =>
    [...byLevel.values()].every((orders) => new Set(orders).size === orders.length);

  it('create\'s own order numbering is locked too - the client\'s actual words were "order numbering", not only the cycle checks (#50)', async () => {
    const { projectId, apiA, apiB } = await setUp();
    const newTopLevelTask = (apiX: Api, name: string) =>
      apiX.post('/tasks', {
        projectId,
        name,
        color: '#2a78d6',
        startDate: '2026-11-02',
        endDate: '2026-11-03',
      }); // no explicit order: both independently compute "next" via TaskService.nextOrder()

    const holder = await holdLock(dbA, projectId);
    const fromA = newTopLevelTask(apiA, 'A3');
    const fromB = newTopLevelTask(apiB, 'B3');
    expect(await settledYet(fromA)).toBe(false);
    expect(await settledYet(fromB)).toBe(false);
    await holder.commitTransaction();
    await holder.release();

    const [resultA, resultB] = await Promise.all([fromA, fromB]);
    expect(resultA.status).toBe(201);
    expect(resultB.status).toBe(201);
    expect(noDuplicateOrders(await levelsOf(apiA, projectId))).toBe(true);
  });

  it("deleting a group's renumbering of the list it leaves its children in is locked against a concurrent create on that same list (#50)", async () => {
    const { projectId, apiA, apiB, task } = await setUp();
    // A group with one child: deleting the group moves the child back to the top level, where it
    // is renumbered alongside whatever else is there - racing a plain create on that same level.
    const group = (
      await apiA
        .post('/tasks', {
          projectId,
          name: 'Group',
          type: 'group',
          color: '#2a78d6',
          startDate: '2026-11-02',
          endDate: '2026-11-03',
        })
        .expect(201)
    ).body as { id: string };
    await task('Child', { parentId: group.id });

    const holder = await holdLock(dbA, projectId);
    const deleteGroup = apiA.delete(`/tasks/${group.id}`);
    const createSibling = apiB.post('/tasks', {
      projectId,
      name: 'NewTop',
      color: '#2a78d6',
      startDate: '2026-11-02',
      endDate: '2026-11-03',
    });

    expect(await settledYet(deleteGroup)).toBe(false);
    expect(await settledYet(createSibling)).toBe(false);
    await holder.commitTransaction();
    await holder.release();

    const [deleted, created] = await Promise.all([deleteGroup, createSibling]);
    expect(deleted.status).toBe(204);
    expect(created.status).toBe(201);
    expect(noDuplicateOrders(await levelsOf(apiA, projectId))).toBe(true);
  });

  it('closes the #21 conflict-check race across instances: the loser is refused (409), never silently overwritten (#50)', async () => {
    const { projectId, x: task, apiA } = await setUp();
    // A second, different user: assertNoConflict ignores a second save by the SAME user (a quick
    // double-save from one screen is not a conflict), so the race only shows up between two people.
    const bob = await signUp('Bob');
    await apiA.post(`/projects/${projectId}/invitations`, { email: bob.email }).expect(201);
    const apiB2 = api(appB, bob.token);
    const version = (task as unknown as { version: number }).version;

    const holder = await holdLock(dbA, projectId);
    const fromOwner = apiA
      .patch(`/tasks/${task.id}`, { name: 'Owner edit' })
      .set('If-Match', String(version));
    const fromBob = apiB2
      .patch(`/tasks/${task.id}`, { name: 'Bob edit' })
      .set('If-Match', String(version));

    expect(await settledYet(fromOwner)).toBe(false);
    expect(await settledYet(fromBob)).toBe(false);
    await holder.commitTransaction();
    await holder.release();

    const [resultOwner, resultBob] = await Promise.all([fromOwner, fromBob]);
    // Both instances read the task at version 1 before either wrote - the old, unlocked check
    // would let both believe they were first. With the lock, whichever's handler runs second sees
    // the winner's already-recorded change and is correctly refused.
    const statuses = [resultOwner.status, resultBob.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = resultOwner.status === 200 ? 'Owner edit' : 'Bob edit';
    const now = (await apiA.get(`/tasks?projectId=${projectId}`).expect(200)).body as {
      id: string;
      name: string;
    }[];
    // The loser's edit never landed, even transiently: the row holds exactly the winner's name.
    expect(now.find((t) => t.id === task.id)!.name).toBe(winner);
  });
});
