import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Like, type Repository } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { User } from '../src/auth/entities/user.entity.js';

// Every project has an owner, and only the owner sees or changes it and everything in it. To
// anyone else it does not exist (404, the same answer as for a made-up id).

describe('Project ownership (e2e)', () => {
  let app: INestApplication;
  let users: Repository<User>;
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
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    // Listening on a port of its own: supertest then reuses it, instead of opening and closing a
    // temporary one for every request (which can refuse a request sent right after another).
    await app.listen(0);
    users = app.get(getRepositoryToken(User));
    ada = await signUp('Ada');
    bob = await signUp('Bob');
  });

  // Deleting the accounts deletes their projects (and all in them) by cascade.
  afterAll(async () => {
    await users.delete({ email: Like('zzown-%') });
    await app.close();
  });

  /** Ada's project with a task, a second task linked to it, and an event. */
  const adasProject = async () => {
    const project = (
      await as(ada, http().post('/projects'))
        .send({ name: `Launch ${randomUUID()}` })
        .expect(201)
    ).body as { id: string; ownerId: string };
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

  it('a new project belongs to its creator, and lists are per owner', async () => {
    const { project } = await adasProject();
    const adaList = (await as(ada, http().get('/projects')).expect(200)).body as { id: string }[];
    const bobList = (await as(bob, http().get('/projects')).expect(200)).body as { id: string }[];
    expect(adaList.map((p) => p.id)).toContain(project.id);
    expect(bobList.map((p) => p.id)).not.toContain(project.id);
    const me = (await as(ada, http().get('/auth/me')).expect(200)).body as { id: string };
    expect(project.ownerId).toBe(me.id);
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

  it('names are unique per owner, not across everyone', async () => {
    const name = `Shared name ${randomUUID()}`;
    await as(ada, http().post('/projects')).send({ name }).expect(201);
    await as(bob, http().post('/projects')).send({ name }).expect(201);
    await as(ada, http().post('/projects')).send({ name }).expect(409);
  });

  it('a malformed id is still a 400 (the route answers it), for the owner and for others', async () => {
    await as(ada, http().patch('/tasks/not-a-uuid')).send({ name: 'x' }).expect(400);
    await as(bob, http().patch('/tasks/not-a-uuid')).send({ name: 'x' }).expect(400);
  });
});
