import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/validation.js';
import { NumberTaskLevels1793000000000 } from '../src/database/migrations/1793000000000-NumberTaskLevels.js';
import { deleteTestAccounts } from './cleanup.js';

/** An index past the end of any list: /move puts the task last. */
const LAST = 10_000;

// Order control (#57): every list level (a group's tasks, or the top level) stays numbered
// 1, 2, 3... in its order after every write: no gap where a task went, no two on one place.

interface TaskBody {
  id: string;
  name: string;
  order: number;
  parentId: string | null;
  changes?: { tasks?: { upsert: TaskBody[] } };
}

describe('Task order: each level numbered 1, 2, 3... (e2e)', () => {
  let app: INestApplication;
  let token = '';
  let projectId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
    const signUp = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({
        name: 'Order',
        email: `zzorder-${randomUUID()}@example.com`,
        password: 'pass-word-1',
      })
      .expect(201);
    token = (signUp.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzorder-');
    await app.close();
  });

  beforeEach(async () => {
    projectId = (
      (
        await call('post', '/projects')
          .send({ name: `zzorder ${randomUUID()}` })
          .expect(201)
      ).body as { id: string }
    ).id;
  });

  const call = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
    request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`);
  const newTask = async (name: string, extra: object = {}) =>
    (
      await call('post', '/tasks')
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
  const move = (id: string, parentId: string | null, index: number) =>
    call('patch', `/tasks/${id}/move`).send({ parentId, index }).expect(200);
  const tasks = async () =>
    (await call('get', `/tasks?projectId=${projectId}`).expect(200)).body as TaskBody[];
  /** Each level's names in order, by the name of its group ('' for the top level). */
  const levels = async () => {
    const all = await tasks();
    const nameOf = new Map(all.map((task) => [task.id, task.name]));
    const out: Record<string, string[]> = {};
    for (const task of [...all].sort((a, b) => a.order - b.order)) {
      const key = task.parentId ? nameOf.get(task.parentId)! : '';
      (out[key] ??= []).push(task.name);
    }
    return out;
  };
  /** Every level numbered exactly 1..n. */
  const expectNumbered = async () => {
    const all = await tasks();
    const byLevel = new Map<string | null, number[]>();
    for (const task of all)
      byLevel.set(task.parentId, [...(byLevel.get(task.parentId) ?? []), task.order]);
    for (const orders of byLevel.values()) {
      expect(orders.sort((a, b) => a - b)).toEqual(orders.map((_, index) => index + 1));
    }
  };

  it('a new task goes last in its own level, not after the highest number in the project', async () => {
    for (const name of ['A', 'B', 'C']) await newTask(name);
    const group = await newTask('G', { type: 'group' });
    const inside = await newTask('G1', { parentId: group.id });
    expect(inside.order).toBe(1);
    expect((await newTask('G2', { parentId: group.id })).order).toBe(2);
    expect(group.order).toBe(4);
    await expectNumbered();
  });

  it('a new task with an order takes that place, the ones from there move down (and its answer says so)', async () => {
    for (const name of ['A', 'B', 'C']) await newTask(name);
    const first = await newTask('New', { order: 1 });
    expect(first.order).toBe(1);
    expect((await levels())['']).toEqual(['New', 'A', 'B', 'C']);
    // The rows it renumbered are in its answer, so other screens update without a reload.
    const moved = Object.fromEntries(
      (first.changes?.tasks?.upsert ?? []).map((task) => [task.name, task.order]),
    );
    expect(moved).toMatchObject({ A: 2, B: 3, C: 4 });
    // An order past the end: last, no gap.
    expect((await newTask('Far', { order: 99 })).order).toBe(5);
    await expectNumbered();
  });

  it('deleting a task closes up its level', async () => {
    const [, b] = [await newTask('A'), await newTask('B'), await newTask('C'), await newTask('D')];
    await call('delete', `/tasks/${b.id}`).expect(204);
    expect((await levels())['']).toEqual(['A', 'C', 'D']);
    await expectNumbered();
  });

  it('moving a task into a group closes up the level it left', async () => {
    const a = await newTask('A');
    await newTask('B');
    const group = await newTask('G', { type: 'group' });
    await newTask('C');
    await newTask('K', { parentId: group.id });
    await move(a.id, group.id, 0);
    expect(await levels()).toEqual({ '': ['B', 'G', 'C'], G: ['A', 'K'] });
    await expectNumbered();
  });

  it('grouping and then releasing (as the board does) leaves 1, 2, 3, 4', async () => {
    const [, b, c] = [
      await newTask('A'),
      await newTask('B'),
      await newTask('C'),
      await newTask('D'),
    ];
    const group = await newTask('Phase', { type: 'group', order: 2 });
    await move(b.id, group.id, 0);
    await move(c.id, group.id, 1);
    expect(await levels()).toEqual({ '': ['A', 'Phase', 'D'], Phase: ['B', 'C'] });
    await expectNumbered();
    // Release: its tasks where it was, then it goes.
    await move(b.id, null, 1);
    await move(c.id, null, 2);
    await call('delete', `/tasks/${group.id}`).expect(204);
    expect((await levels())['']).toEqual(['A', 'B', 'C', 'D']);
    expect((await tasks()).map((task) => task.order).sort()).toEqual([1, 2, 3, 4]);
  });

  it('undoing a new task closes up its level; undoing a delete puts the task back at its place', async () => {
    await newTask('A');
    const b = await newTask('B');
    await newTask('C');
    await newTask('X', { order: 2 });
    await call('post', `/projects/${projectId}/undo`).expect(200);
    expect((await levels())['']).toEqual(['A', 'B', 'C']);
    await expectNumbered();
    await call('delete', `/tasks/${b.id}`).expect(204);
    await call('post', `/projects/${projectId}/undo`).expect(200);
    expect((await levels())['']).toEqual(['A', 'B', 'C']);
    await expectNumbered();
  });

  it('restoring a deleted task from the history puts it back at its place', async () => {
    await newTask('A');
    const b = await newTask('B');
    await newTask('C');
    await call('delete', `/tasks/${b.id}`).expect(204);
    const history = (await call('get', `/projects/${projectId}/revisions`).expect(200)).body as {
      id: string;
      entityId: string;
      action: string;
    }[];
    const deletion = history.find((r) => r.entityId === b.id && r.action === 'delete')!;
    await call('post', `/revisions/${deletion.id}/restore`).expect(200);
    expect((await levels())['']).toEqual(['A', 'B', 'C']);
    await expectNumbered();
  });

  it('restoring a task back into its group puts it at the place it had there', async () => {
    const group = await newTask('G', { type: 'group' });
    const k = await newTask('K', { parentId: group.id });
    await newTask('L', { parentId: group.id });
    await move(k.id, null, LAST);
    expect(await levels()).toEqual({ '': ['G', 'K'], G: ['L'] });
    const history = (await call('get', `/projects/${projectId}/revisions`).expect(200)).body as {
      id: string;
      entityId: string;
      action: string;
    }[];
    const made = history.find((r) => r.entityId === k.id && r.action === 'create')!;
    await call('post', `/revisions/${made.id}/restore`).expect(200);
    expect(await levels()).toEqual({ '': ['G'], G: ['K', 'L'] });
    await expectNumbered();
  });

  it('restoring a version leaves every level numbered, even one saved with gaps (old data)', async () => {
    const a = await newTask('A');
    const b = await newTask('B');
    // Saved before levels were kept numbered: B on 7.
    await app.get(DataSource).query(`UPDATE "tasks" SET "order" = 7 WHERE "id" = $1`, [b.id]);
    const version = (await call('post', `/projects/${projectId}/versions`).expect(201)).body as {
      id: string;
    };
    await call('delete', `/tasks/${a.id}`).expect(204);
    await newTask('C', { order: 1 });
    await call('post', `/versions/${version.id}/restore`).expect(200);
    expect((await levels())['']).toEqual(['A', 'B']);
    await expectNumbered();
  });

  it('the migration numbers levels stored with gaps and clashes, keeping their order', async () => {
    const a = await newTask('A');
    const b = await newTask('B');
    const c = await newTask('C');
    const group = await newTask('G', { type: 'group' });
    const k = await newTask('K', { parentId: group.id });
    // As old data could be: gaps, two on one place, a group's task numbered past the project.
    const db = app.get(DataSource);
    const set = (id: string, order: number) =>
      db.query(`UPDATE "tasks" SET "order" = $2 WHERE "id" = $1`, [id, order]);
    await set(a.id, 3);
    await set(b.id, 7);
    await set(c.id, 7);
    await set(group.id, 12);
    await set(k.id, 40);

    const runner = db.createQueryRunner();
    try {
      await new NumberTaskLevels1793000000000().up(runner);
    } finally {
      await runner.release();
    }

    expect(await levels()).toEqual({ '': ['A', 'B', 'C', 'G'], G: ['K'] });
    await expectNumbered();
  });
});
