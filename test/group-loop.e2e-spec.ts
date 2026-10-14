import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/validation.js';
import { deleteTestAccounts } from './cleanup.js';

// Groups that loop into each other (P inside Q inside P). Nothing writes one now, but old data may
// hold one (the single-instance race fixed in #50). Every walk over the groups must still come to
// an end: a write that met the loop used to go round forever, holding the project's lock (or, in
// the scheduler, the whole server). Each request here must answer within TIMEOUT_MS.

const TIMEOUT_MS = 5_000;
const LOOP = "This project's groups loop into each other";

interface TaskBody {
  id: string;
  parentId: string | null;
}

describe('Groups that loop into each other (e2e)', () => {
  let app: INestApplication;
  let token = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
    const signUp = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ name: 'Loop', email: `zzloop-${randomUUID()}@example.com`, password: 'pass-word-1' })
      .expect(201);
    token = (signUp.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzloop-');
    await app.close();
  });

  const call = (method: 'get' | 'post' | 'patch', path: string, body?: object) =>
    request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .timeout(TIMEOUT_MS);
  const newTask = async (projectId: string, name: string, extra: object = {}) =>
    (
      await call('post', '/tasks', {
        projectId,
        name,
        color: '#2a78d6',
        startDate: '2026-11-02',
        endDate: '2026-11-03',
        ...extra,
      }).expect(201)
    ).body as TaskBody;

  /** A project with groups P and Q (Q inside P), task T (made inside P, then moved out) and X. */
  const setUp = async () => {
    const projectId = (
      (await call('post', '/projects', { name: `Loop ${randomUUID()}` }).expect(201)).body as {
        id: string;
      }
    ).id;
    const p = await newTask(projectId, 'P', { type: 'group' });
    const q = await newTask(projectId, 'Q', { type: 'group', parentId: p.id });
    const t = await newTask(projectId, 'T', { parentId: p.id });
    await call('patch', `/tasks/${t.id}/parent`, { parentId: null }).expect(200);
    const x = await newTask(projectId, 'X');
    // The loop, written straight into the database as old data would hold it: P inside Q.
    await app
      .get(DataSource)
      .query(`UPDATE "tasks" SET "parentId" = $2 WHERE "id" = $1`, [p.id, q.id]);
    return { projectId, p, q, t, x };
  };
  const parentOf = async (projectId: string, id: string) =>
    ((await call('get', `/tasks?projectId=${projectId}`).expect(200)).body as TaskBody[]).find(
      (task) => task.id === id,
    )!.parentId;

  it('moving a task under a group of the loop is refused, not walked forever', async () => {
    const { projectId, p, t } = await setUp();
    const moved = await call('patch', `/tasks/${t.id}/parent`, { parentId: p.id });
    expect(moved.status).toBe(409);
    expect((moved.body as { message: string }).message).toMatch(LOOP);
    const dropped = await call('patch', `/tasks/${t.id}/move`, { parentId: p.id, index: 0 });
    expect(dropped.status).toBe(409);
    expect(await parentOf(projectId, t.id)).toBeNull();
  });

  it('linking to a task of the loop is refused, not walked forever', async () => {
    const { x, q } = await setUp();
    const linked = await call('post', '/dependencies', { fromTaskId: x.id, toTaskId: q.id });
    expect(linked.status).toBe(409);
    expect((linked.body as { message: string }).message).toMatch(LOOP);
  });

  it('restoring a task into a group of the loop leaves it where it is', async () => {
    const { projectId, t } = await setUp();
    const revisions = (await call('get', `/projects/${projectId}/revisions?limit=100`).expect(200))
      .body as { id: string; entityId: string; action: string }[];
    // Its first revision has it inside P.
    const made = revisions.find((r) => r.entityId === t.id && r.action === 'create')!;
    const restored = await call('post', `/revisions/${made.id}/restore`);
    expect(restored.status).toBeLessThan(300);
    expect((restored.body as { skipped: string[] }).skipped).toEqual([
      'its group (gone, no longer a group, or in a loop of groups): it stays where it is',
    ]);
    expect(await parentOf(projectId, t.id)).toBeNull();
  });

  it('a link pushing a group of the loop still gets an answer (the scheduler moves each task once)', async () => {
    const { projectId, x, p } = await setUp();
    // A link into the loop, also as old data: then moving X later pushes P (and what is in it).
    await app.get(DataSource).query(
      `INSERT INTO "task_dependencies" ("projectId", "fromTaskId", "toTaskId", "type", "lagDays")
         VALUES ($1, $2, $3, 'FS', 0)`,
      [projectId, x.id, p.id],
    );
    const edited = await call('patch', `/tasks/${x.id}`, {
      startDate: '2026-11-09',
      endDate: '2026-11-12',
    });
    expect(edited.status).toBeLessThan(500);
  });

  it('moving a group of the loop out to the top level mends it', async () => {
    const { projectId, p, q, t } = await setUp();
    await call('patch', `/tasks/${p.id}/parent`, { parentId: null }).expect(200);
    expect(await parentOf(projectId, p.id)).toBeNull();
    expect(await parentOf(projectId, q.id)).toBe(p.id);
    // Mended: a move under P goes through again.
    await call('patch', `/tasks/${t.id}/parent`, { parentId: p.id }).expect(200);
  });
});
