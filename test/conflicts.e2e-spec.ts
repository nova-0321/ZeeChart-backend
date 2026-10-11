import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { deleteTestAccounts } from './cleanup.js';

// Conflict checks (#21): a write made from an older version (If-Match) is refused only when someone
// else changed the same fields since; anything else goes through.

interface Account {
  token: string;
  id: string;
  email: string;
}
interface TaskBody {
  id: string;
  name: string;
  version: number;
  startDate: string;
  endDate: string;
  progress: number;
  color: string;
}
interface ConflictBody {
  statusCode: number;
  message: string;
  details: {
    conflict: true;
    fields: string[];
    changedBy: { id: string; name: string } | null;
    current: Record<string, unknown>;
    version: number;
  };
}

describe('Conflicts (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const as = (account: Account, call: request.Test) =>
    call.set('Authorization', `Bearer ${account.token}`);

  const signUp = async (name: string): Promise<Account> => {
    const body = (
      await http()
        .post('/auth/signup')
        .send({ name, email: `zzconf-${randomUUID()}@example.com`, password: 'pass-word-1' })
        .expect(201)
    ).body as { accessToken: string; user: { id: string; email: string } };
    return { token: body.accessToken, id: body.user.id, email: body.user.email };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0);
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzconf-');
    await app.close();
  });

  /** Olive's project, with Bob as an editor, and a task in it. */
  const setUp = async () => {
    const olive = await signUp('Olive');
    const bob = await signUp('Bob');
    const project = (
      await as(olive, http().post('/projects'))
        .send({ name: `zzconf ${randomUUID()}` })
        .expect(201)
    ).body as { id: string; version: number };
    await as(olive, http().post(`/projects/${project.id}/members`))
      .send({ email: bob.email })
      .expect(201);
    const task = await newTask(olive, project.id, { name: 'Design' });
    return { olive, bob, projectId: project.id, task };
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
  const patch = (who: Account, id: string, body: object, version?: number) => {
    const call = as(who, http().patch(`/tasks/${id}`)).send(body);
    return version === undefined ? call : call.set('If-Match', String(version));
  };
  const taskOf = async (who: Account, projectId: string, id: string) =>
    (
      (await as(who, http().get(`/tasks?projectId=${projectId}`)).expect(200)).body as TaskBody[]
    ).find((t) => t.id === id)!;

  it('versions: a new row has 1, every change adds one, the answer carries the new one', async () => {
    const { olive, projectId, task } = await setUp();
    expect(task.version).toBe(1);
    const renamed = (await patch(olive, task.id, { name: 'Design v2' }, 1).expect(200))
      .body as TaskBody;
    expect(renamed.version).toBe(2);
    expect((await taskOf(olive, projectId, task.id)).version).toBe(2);
    const projects = (await as(olive, http().get('/projects')).expect(200)).body as {
      id: string;
      version: number;
    }[];
    expect(projects.find((p) => p.id === projectId)!.version).toBe(1);
  });

  it('someone else changed the same field since: 409, saying who and what; nothing saved', async () => {
    const { olive, bob, projectId, task } = await setUp();
    await patch(bob, task.id, { name: 'Bob’s name' }, 1).expect(200);
    const history = async () =>
      (
        (await as(olive, http().get(`/projects/${projectId}/revisions`)).expect(200))
          .body as unknown[]
      ).length;
    const count = await history();
    const refused = await patch(olive, task.id, { name: 'Olive’s name' }, 1);
    expect(refused.status).toBe(409);
    const body = refused.body as ConflictBody;
    expect(body.message).toBe(
      "Bob changed the name of “Bob’s name” meanwhile. Your change wasn't saved",
    );
    expect(body.details).toMatchObject({
      conflict: true,
      fields: ['name'],
      changedBy: { id: bob.id, name: 'Bob' },
      current: { id: task.id, name: 'Bob’s name' },
      version: 2,
    });
    expect((await taskOf(olive, projectId, task.id)).name).toBe('Bob’s name');
    expect(await history()).toBe(count);
    // With the version the conflict gave: saved over it.
    await patch(olive, task.id, { name: 'Olive’s name' }, body.details.version).expect(200);
    expect((await taskOf(olive, projectId, task.id)).name).toBe('Olive’s name');
  });

  it('someone else changed other fields since: no conflict, both changes kept', async () => {
    const { olive, bob, projectId, task } = await setUp();
    await patch(bob, task.id, { color: '#e5484d' }, 1).expect(200);
    await patch(olive, task.id, { startDate: '2026-11-09', endDate: '2026-11-12' }, 1).expect(200);
    const now = await taskOf(olive, projectId, task.id);
    expect([now.color, now.startDate.slice(0, 10)]).toEqual(['#e5484d', '2026-11-09']);
    expect(now.version).toBe(3);
  });

  it('your own changes since are never a conflict (quick saves from one screen)', async () => {
    const { olive, projectId, task } = await setUp();
    await patch(olive, task.id, { progress: 20 }, 1).expect(200);
    await patch(olive, task.id, { progress: 40 }, 1).expect(200);
    expect((await taskOf(olive, projectId, task.id)).progress).toBe(40);
  });

  it('a group the server stretched: renaming it is fine, moving its dates is a conflict', async () => {
    const { olive, bob, projectId } = await setUp();
    const group = await newTask(olive, projectId, { name: 'Phase', type: 'group' });
    const child = await newTask(olive, projectId, { name: 'Build', parentId: group.id });
    const seen = (await taskOf(olive, projectId, group.id)).version;
    // Bob moves the task: the server stretches the group (a change by Bob's request).
    await patch(bob, child.id, { startDate: '2026-11-20', endDate: '2026-11-25' }).expect(200);
    expect((await taskOf(olive, projectId, group.id)).version).toBe(seen + 1);
    await patch(olive, group.id, { name: 'Phase 1' }, seen).expect(200);
    const refused = await patch(
      olive,
      group.id,
      { startDate: '2026-11-01', endDate: '2026-11-30' },
      seen,
    );
    expect(refused.status).toBe(409);
    expect((refused.body as ConflictBody).message).toMatch(/^Bob changed the dates of “Phase 1”/);
  });

  it('deleting what someone changed since is a conflict; moving it is checked on its place', async () => {
    const { olive, bob, projectId, task } = await setUp();
    await patch(bob, task.id, { progress: 50 }, 1).expect(200);
    const refused = await as(olive, http().delete(`/tasks/${task.id}`)).set('If-Match', '1');
    expect(refused.status).toBe(409);
    expect((refused.body as ConflictBody).details.fields).toEqual(['progress']);
    expect(await taskOf(olive, projectId, task.id)).toBeDefined();
    // Its place in the list: Bob's progress change doesn't touch it.
    await as(olive, http().patch(`/tasks/${task.id}/move`))
      .set('If-Match', '1')
      .send({ parentId: null, index: 0 })
      .expect(200);
    await as(olive, http().delete(`/tasks/${task.id}`))
      .set('If-Match', '3')
      .expect(204);
  });

  it('events, links and the project are checked too', async () => {
    const { olive, bob, projectId, task } = await setUp();
    const event = (
      await as(olive, http().post('/events'))
        .send({
          projectId,
          name: 'Freeze',
          color: '#e5484d',
          startDate: '2026-11-12',
          endDate: '2026-11-12',
        })
        .expect(201)
    ).body as { id: string; version: number };
    await as(bob, http().patch(`/events/${event.id}`))
      .send({ name: 'Freeze!' })
      .expect(200);
    const eventRefused = await as(olive, http().patch(`/events/${event.id}`))
      .set('If-Match', String(event.version))
      .send({ name: 'Code freeze' });
    expect(eventRefused.status).toBe(409);

    const next = await newTask(olive, projectId, {
      name: 'Next',
      startDate: '2026-11-09',
      endDate: '2026-11-10',
    });
    const link = (
      await as(olive, http().post('/dependencies'))
        .send({ fromTaskId: task.id, toTaskId: next.id })
        .expect(201)
    ).body as { id: string; version: number };
    expect(link.version).toBe(1);
    await as(bob, http().patch(`/dependencies/${link.id}`))
      .send({ lagDays: 2 })
      .expect(200);
    const linkRefused = await as(olive, http().patch(`/dependencies/${link.id}`))
      .set('If-Match', '1')
      .send({ lagDays: 3 });
    expect(linkRefused.status).toBe(409);
    expect((linkRefused.body as ConflictBody).message).toBe(
      "Bob changed the lag of the link meanwhile. Your change wasn't saved",
    );

    // The project: Olive archives it from an old version after Bob... (owners only) renames it.
    const owner2 = await signUp('Ann');
    await as(olive, http().post(`/projects/${projectId}/members`))
      .send({ email: owner2.email, role: 'owner' })
      .expect(201);
    await as(owner2, http().patch(`/projects/${projectId}/archive`)).expect(200);
    const archiveRefused = await as(olive, http().patch(`/projects/${projectId}/reopen`)).set(
      'If-Match',
      '1',
    );
    expect(archiveRefused.status).toBe(409);
    expect((archiveRefused.body as ConflictBody).details.fields).toEqual(['archived']);
  });

  it('no If-Match: as before (no check); a malformed one: 400', async () => {
    const { olive, bob, projectId, task } = await setUp();
    await patch(bob, task.id, { name: 'Bob’s' }).expect(200);
    await patch(olive, task.id, { name: 'Olive’s' }).expect(200);
    expect((await taskOf(olive, projectId, task.id)).name).toBe('Olive’s');
    await as(olive, http().patch(`/tasks/${task.id}`))
      .set('If-Match', 'yesterday')
      .send({ name: 'x' })
      .expect(400);
    // The quoted forms of HTTP are taken too.
    await as(olive, http().patch(`/tasks/${task.id}`))
      .set('If-Match', 'W/"3"')
      .send({ name: 'Quoted' })
      .expect(200);
  });
});
