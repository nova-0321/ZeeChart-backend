import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createValidationPipe } from '../src/common/validation.js';
import { deleteTestAccounts } from './cleanup.js';

/** An index past the end of any list: /move puts the task last (as the removed /parent did). */
const LAST = 10_000;

// A write is one transaction on one connection (RequestTransaction): its changes, its history and
// the project's lock. This app gets a pool of ONE connection, so a query anywhere in a write that
// still went to the pool on its own (outside the write's transaction, so not undone with it) would
// wait for the only connection, held by the write itself: the request would never answer. Every
// write route runs here once; each must answer in time.

const TIMEOUT_MS = 8_000;

describe('Every write on one database connection (e2e)', () => {
  let app: INestApplication;
  let token = '';

  beforeAll(async () => {
    // Read when the app's configuration loads, so before it is imported.
    process.env.DB_POOL_SIZE = '1';
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
    const signUp = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ name: 'Solo', email: `zzsolo-${randomUUID()}@example.com`, password: 'pass-word-1' })
      .expect(201);
    token = (signUp.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzsolo-');
    await app.close();
  });

  /** A write that must succeed, answered within TIMEOUT_MS: the body, typed by the caller. */
  const write = async <T = { id: string }>(
    method: 'post' | 'patch' | 'delete',
    path: string,
    body: object = {},
  ) => {
    const response = await request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .timeout(TIMEOUT_MS);
    expect(
      response.status,
      `${method.toUpperCase()} ${path}: ${JSON.stringify(response.body)}`,
    ).toBeLessThan(300);
    return response.body as T;
  };
  const read = async <T>(path: string) =>
    (
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token}`)
        .timeout(TIMEOUT_MS)
        .expect(200)
    ).body as T;
  const dates = { startDate: '2026-11-02', endDate: '2026-11-06' };

  it('answers every write route', async () => {
    const project = await write('post', '/projects', { name: `Solo ${randomUUID()}` });
    const p = project.id;
    await write('patch', `/projects/${p}`, { name: `Solo renamed ${randomUUID()}` });

    // Tasks: a group with a task in it (the scheduler fits the group), and plain ones.
    const task = (name: string, extra: object = {}) =>
      write('post', '/tasks', { projectId: p, name, color: '#2a78d6', ...dates, ...extra });
    const group = await task('Group', { type: 'group' });
    const inGroup = await task('In group', { parentId: group.id });
    const a = await task('A');
    const c = await task('C');
    await write('patch', `/tasks/${a.id}`, { startDate: '2026-11-03', endDate: '2026-11-09' });
    await write('patch', `/tasks/${c.id}/move`, { parentId: group.id, index: LAST });
    await write('patch', `/tasks/${c.id}/move`, { parentId: null, index: 0 });
    await write('patch', `/tasks/${c.id}/type`, { type: 'milestone' });

    // Links: one that pushes its successor, changed, removed; another one kept for the restore.
    const link = await write('post', '/dependencies', { fromTaskId: a.id, toTaskId: inGroup.id });
    await write('patch', `/dependencies/${link.id}`, { lagDays: 1 });
    await write('delete', `/dependencies/${link.id}`);
    await write('post', '/dependencies', { fromTaskId: c.id, toTaskId: a.id });

    // Events.
    const event = await write('post', '/events', {
      projectId: p,
      name: 'Freeze',
      color: '#e5484d',
      ...dates,
    });
    await write('patch', `/events/${event.id}`, { name: 'Code freeze' });
    await write('delete', `/events/${event.id}`);

    // A member added and taken away again by the owner (its own transaction, outside the
    // interceptor: the owner check must read through it too).
    const email = `zzsolo-${randomUUID()}@example.com`;
    await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ name: 'Guest', email, password: 'pass-word-1' })
      .timeout(TIMEOUT_MS)
      .expect(201);
    const added = await write<{ member: { id: string } }>('post', `/projects/${p}/invitations`, {
      email,
    });
    await write('delete', `/members/${added.member.id}`);
    // Someone without an account gets an invitation instead: whether they have signed up meanwhile
    // is read again inside the invite's transaction (AuthService.hasAccount with its manager).
    const invited = await write<{ invitation: { id: string } }>(
      'post',
      `/projects/${p}/invitations`,
      { email: `zzsolo-${randomUUID()}@example.com` },
    );
    await write('delete', `/invitations/${invited.invitation.id}`);

    // Undo and redo of the last change.
    await write('post', `/projects/${p}/undo`);
    await write('post', `/projects/${p}/redo`);

    // A deleted task restored from its history, with its link (a new link, checked again).
    await write('delete', `/tasks/${a.id}`);
    const revisions = await read<{ id: string; entityId: string; action: string }[]>(
      `/projects/${p}/revisions`,
    );
    const deleted = revisions.find((r) => r.entityId === a.id && r.action === 'delete')!;
    await write('post', `/revisions/${deleted.id}/restore`);

    // Versions: saved by hand, starred, restored (by an owner: the name too), copied.
    const version = await write('post', `/projects/${p}/versions`);
    await write('patch', `/versions/${version.id}`, { starred: true });
    await write('patch', `/tasks/${inGroup.id}`, { name: 'Renamed after the version' });
    await write('post', `/versions/${version.id}/restore`);
    const copy = await write('post', `/versions/${version.id}/copy`);
    await write('delete', `/projects/${copy.id}`);

    // The project itself.
    await write('patch', `/projects/${p}`, { archived: true });
    await write('patch', `/projects/${p}`, { archived: false });
    await write('delete', `/projects/${p}`);
  }, 120_000);
});
