import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { deleteTestAccounts } from './cleanup.js';
import { createValidationPipe } from '../src/common/validation.js';

// Every project has an owner, and only its members see it and everything in it. To anyone else it
// does not exist (404, the same answer as for a made-up id). Roles inside a project are in
// members.e2e-spec.ts.

describe('Project ownership (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  let ada: string; // tokens
  let bob: string;

  const signUp = async (name: string) =>
    (
      (
        await http()
          .post('/auth/signup')
          .send({ name, email: `zzown-${randomUUID()}@example.com`, password: 'pass-word-1' })
          .expect(201)
      ).body as { accessToken: string }
    ).accessToken;
  /** A request as someone (a token), or as no one. */
  const as = (token: string | null, call: request.Test) =>
    token ? call.set('Authorization', `Bearer ${token}`) : call;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    // Listening on a port of its own: supertest then reuses it, instead of opening and closing a
    // temporary one for every request (which can refuse a request sent right after another).
    await app.listen(0);
    ada = await signUp('Ada');
    bob = await signUp('Bob');
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzown-');
    await app.close();
  });

  /** Ada's project with a task, a second task linked to it, and an event. */
  const adasProject = async () => {
    const project = (
      await as(ada, http().post('/projects'))
        .send({ name: `Launch ${randomUUID()}` })
        .expect(201)
    ).body as { id: string; role: string };
    const task = (body: object) =>
      as(ada, http().post('/tasks'))
        .send({
          projectId: project.id,
          color: '#2a78d6',
          startDate: '2026-11-02',
          endDate: '2026-11-06',
          ...body,
        })
        .expect(201)
        .then((r) => r.body as { id: string });
    const first = await task({ name: 'First' });
    const second = await task({ name: 'Second', startDate: '2026-11-09', endDate: '2026-11-10' });
    const link = (
      await as(ada, http().post('/dependencies'))
        .send({ fromTaskId: first.id, toTaskId: second.id })
        .expect(201)
    ).body as { id: string };
    const event = (
      await as(ada, http().post('/events'))
        .send({
          projectId: project.id,
          name: 'Demo',
          color: '#e5484d',
          startDate: '2026-11-12',
          endDate: '2026-11-12',
        })
        .expect(201)
    ).body as { id: string };
    return { project, first, second, link, event };
  };

  it('signed out, nothing about projects is reachable (401)', async () => {
    const { project, first } = await adasProject();
    const calls = [
      () => http().get('/projects'),
      () => http().post('/projects').send({ name: 'x' }),
      () => http().get(`/projects/${project.id}`),
      () => http().get(`/tasks?projectId=${project.id}`),
      () => http().patch(`/tasks/${first.id}`).send({ name: 'x' }),
      () => http().get(`/dependencies?projectId=${project.id}`),
      () => http().get(`/events?projectId=${project.id}`),
    ];
    for (const call of calls) await call().expect(401);
  });

  it('a new project belongs to its creator, and lists are per member', async () => {
    const { project } = await adasProject();
    const adaList = (await as(ada, http().get('/projects')).expect(200)).body as { id: string }[];
    const bobList = (await as(bob, http().get('/projects')).expect(200)).body as { id: string }[];
    expect(adaList.map((p) => p.id)).toContain(project.id);
    expect(bobList.map((p) => p.id)).not.toContain(project.id);
    expect(project.role).toBe('owner');
    expect(adaList.find((p) => p.id === project.id)).toMatchObject({
      role: 'owner',
      addedBy: null,
    });
    const members = (await as(ada, http().get(`/projects/${project.id}/members`)).expect(200))
      .body as { userId: string; role: string }[];
    const me = (await as(ada, http().get('/auth/me')).expect(200)).body as { id: string };
    expect(members.map((m) => [m.userId, m.role])).toEqual([[me.id, 'owner']]);
  });

  it("someone else's project, and everything in it, is a 404 for every route", async () => {
    const { project, first, second, link, event } = await adasProject();
    const tries: [string, () => request.Test][] = [
      ['GET project', () => as(bob, http().get(`/projects/${project.id}`))],
      ['rename', () => as(bob, http().patch(`/projects/${project.id}`)).send({ name: 'Mine now' })],
      ['archive', () => as(bob, http().patch(`/projects/${project.id}/archive`))],
      ['reopen', () => as(bob, http().patch(`/projects/${project.id}/reopen`))],
      ['delete project', () => as(bob, http().delete(`/projects/${project.id}`))],
      ['list tasks', () => as(bob, http().get(`/tasks?projectId=${project.id}`))],
      [
        'add a task',
        () =>
          as(bob, http().post('/tasks')).send({
            projectId: project.id,
            name: 'x',
            color: '#2a78d6',
            startDate: '2026-11-02',
            endDate: '2026-11-03',
          }),
      ],
      ['edit a task', () => as(bob, http().patch(`/tasks/${first.id}`)).send({ name: 'x' })],
      [
        'move a task',
        () => as(bob, http().patch(`/tasks/${first.id}/move`)).send({ parentId: null, index: 0 }),
      ],
      [
        'regroup a task',
        () => as(bob, http().patch(`/tasks/${first.id}/parent`)).send({ parentId: null }),
      ],
      [
        'retype a task',
        () => as(bob, http().patch(`/tasks/${first.id}/type`)).send({ type: 'milestone' }),
      ],
      ['delete a task', () => as(bob, http().delete(`/tasks/${second.id}`))],
      ['list links', () => as(bob, http().get(`/dependencies?projectId=${project.id}`))],
      [
        'link tasks',
        () =>
          as(bob, http().post('/dependencies')).send({ fromTaskId: second.id, toTaskId: first.id }),
      ],
      ['edit a link', () => as(bob, http().patch(`/dependencies/${link.id}`)).send({ lagDays: 3 })],
      ['delete a link', () => as(bob, http().delete(`/dependencies/${link.id}`))],
      ['list events', () => as(bob, http().get(`/events?projectId=${project.id}`))],
      [
        'add an event',
        () =>
          as(bob, http().post('/events')).send({
            projectId: project.id,
            name: 'x',
            color: '#e5484d',
            startDate: '2026-11-12',
            endDate: '2026-11-12',
          }),
      ],
      ['edit an event', () => as(bob, http().patch(`/events/${event.id}`)).send({ name: 'x' })],
      ['delete an event', () => as(bob, http().delete(`/events/${event.id}`))],
      ['list members', () => as(bob, http().get(`/projects/${project.id}/members`))],
      [
        'invite a member',
        () =>
          as(bob, http().post(`/projects/${project.id}/invitations`)).send({
            email: 'x@example.com',
          }),
      ],
    ];
    const answers: string[] = [];
    for (const [label, call] of tries) answers.push(`${label}: ${(await call()).status}`);
    expect(answers).toEqual(tries.map(([label]) => `${label}: 404`));

    // Nothing changed.
    const tasks = (await as(ada, http().get(`/tasks?projectId=${project.id}`)).expect(200))
      .body as { name: string; type: string }[];
    expect(tasks.map((t) => `${t.name}:${t.type}`).sort()).toEqual(['First:task', 'Second:task']);
    const links = (await as(ada, http().get(`/dependencies?projectId=${project.id}`)).expect(200))
      .body as { lagDays: number }[];
    expect(links).toHaveLength(1);
    expect(links[0]!.lagDays).toBe(0);
    const events = (await as(ada, http().get(`/events?projectId=${project.id}`)).expect(200))
      .body as { name: string }[];
    expect(events.map((e) => e.name)).toEqual(['Demo']);
    const still = (await as(ada, http().get(`/projects/${project.id}`)).expect(200)).body as {
      name: string;
      archived: boolean;
    };
    expect(still.archived).toBe(false);
  });

  it("someone else's things look exactly like ones that don't exist", async () => {
    const { project, first } = await adasProject();
    const bodyOf = async (call: request.Test) => {
      const r = await call;
      return `${r.status} ${(r.body as { message: string }).message}`;
    };
    expect(await bodyOf(as(bob, http().get(`/projects/${project.id}`)))).toBe(
      await bodyOf(as(bob, http().get(`/projects/${randomUUID()}`))),
    );
    expect(await bodyOf(as(bob, http().patch(`/tasks/${first.id}`)).send({ name: 'x' }))).toBe(
      await bodyOf(as(bob, http().patch(`/tasks/${randomUUID()}`)).send({ name: 'x' })),
    );
  });

  it('the owner can do everything', async () => {
    const { project, first, link, event } = await adasProject();
    await as(ada, http().patch(`/tasks/${first.id}`))
      .send({ name: 'Renamed' })
      .expect(200);
    await as(ada, http().patch(`/dependencies/${link.id}`))
      .send({ lagDays: 2 })
      .expect(200);
    await as(ada, http().patch(`/events/${event.id}`))
      .send({ name: 'Demo day' })
      .expect(200);
    await as(ada, http().patch(`/projects/${project.id}/archive`)).expect(200);
    await as(ada, http().patch(`/projects/${project.id}/reopen`)).expect(200);
    await as(ada, http().delete(`/projects/${project.id}`)).expect(200);
    await as(ada, http().get(`/projects/${project.id}`)).expect(404);
  });

  it('names are unique among your projects, not across everyone', async () => {
    const name = `Shared name ${randomUUID()}`;
    const first = (await as(ada, http().post('/projects')).send({ name }).expect(201)).body as {
      id: string;
    };
    await as(bob, http().post('/projects')).send({ name }).expect(201);
    await as(ada, http().post('/projects')).send({ name }).expect(409);
    // Renaming into a name you have is refused too; keeping your own name is not a clash.
    const other = (
      await as(ada, http().post('/projects'))
        .send({ name: `Other ${randomUUID()}` })
        .expect(201)
    ).body as { id: string };
    await as(ada, http().patch(`/projects/${other.id}`))
      .send({ name })
      .expect(409);
    await as(ada, http().patch(`/projects/${first.id}`))
      .send({ name })
      .expect(200);
  });

  it('two projects of the same name made at once: one of them is refused', async () => {
    const name = `Race ${randomUUID()}`;
    const answers = await Promise.all(
      [1, 2, 3].map(() => as(ada, http().post('/projects')).send({ name })),
    );
    expect(answers.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it('a malformed id is still a 400 (the route answers it), for the owner and for others', async () => {
    await as(ada, http().patch('/tasks/not-a-uuid')).send({ name: 'x' }).expect(400);
    await as(bob, http().patch('/tasks/not-a-uuid')).send({ name: 'x' }).expect(400);
  });
});
