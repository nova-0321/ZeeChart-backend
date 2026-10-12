import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { ARCHIVED_MESSAGE } from '../src/projects/project-access.js';
import { deleteTestAccounts } from './cleanup.js';

// An archived project is read-only: nothing in its plan changes (tasks, groups, milestones, links,
// events, undo/redo, restores) until an owner reopens it. Reading, renaming, reopening, deleting,
// members, and saving/starring/copying versions still work.

describe('Archived projects (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  let ada: string; // owner
  let eve: string; // editor
  let vic: string; // viewer
  let eveEmail: string;
  let vicEmail: string;

  const signUp = async (name: string) => {
    const email = `zzarch-${name.toLowerCase()}-${randomUUID()}@example.com`;
    const body = (
      await http().post('/auth/signup').send({ name, email, password: 'pass-word-1' }).expect(201)
    ).body as { accessToken: string };
    return { token: body.accessToken, email };
  };
  const as = (token: string, call: request.Test) => call.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0);
    ({ token: ada } = await signUp('Ada'));
    ({ token: eve, email: eveEmail } = await signUp('Eve'));
    ({ token: vic, email: vicEmail } = await signUp('Vic'));
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzarch-');
    await app.close();
  });

  /** Ada's project (Eve editor, Vic viewer) with a group, two tasks, a link and an event. */
  const plan = async () => {
    const project = (
      await as(ada, http().post('/projects'))
        .send({ name: `Archive ${randomUUID()}` })
        .expect(201)
    ).body as { id: string };
    for (const [email, role] of [
      [eveEmail, 'editor'],
      [vicEmail, 'viewer'],
    ]) {
      await as(ada, http().post(`/projects/${project.id}/members`))
        .send({ email, role })
        .expect(201);
    }
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
    const group = await task({ name: 'Group', type: 'group' });
    const first = await task({ name: 'First', parentId: group.id });
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
    const revisions = (await as(ada, http().get(`/projects/${project.id}/revisions`)).expect(200))
      .body as { id: string }[] | { items: { id: string }[] };
    const revisionId = (Array.isArray(revisions) ? revisions : revisions.items)[0].id;
    const version = (await as(ada, http().post(`/projects/${project.id}/versions`)).expect(201))
      .body as { id: string };
    return { project, group, first, second, link, event, revisionId, versionId: version.id };
  };

  /** Every change to the plan, as `who`. */
  const planChanges = (who: string, p: Awaited<ReturnType<typeof plan>>) =>
    [
      [
        'create task',
        () =>
          as(who, http().post('/tasks')).send({
            projectId: p.project.id,
            name: 'X',
            color: '#2a78d6',
            startDate: '2026-11-02',
            endDate: '2026-11-03',
          }),
      ],
      [
        'create milestone',
        () =>
          as(who, http().post('/tasks')).send({
            projectId: p.project.id,
            name: 'M',
            type: 'milestone',
            color: '#2a78d6',
            startDate: '2026-11-02',
            endDate: '2026-11-02',
          }),
      ],
      ['edit task', () => as(who, http().patch(`/tasks/${p.second.id}`)).send({ name: 'Renamed' })],
      [
        'edit group',
        () => as(who, http().patch(`/tasks/${p.group.id}`)).send({ name: 'Renamed group' }),
      ],
      [
        'move task',
        () =>
          as(who, http().patch(`/tasks/${p.second.id}/move`)).send({ parentId: null, index: 0 }),
      ],
      [
        'change parent',
        () => as(who, http().patch(`/tasks/${p.second.id}/parent`)).send({ parentId: p.group.id }),
      ],
      [
        'change type',
        () => as(who, http().patch(`/tasks/${p.second.id}/type`)).send({ type: 'milestone' }),
      ],
      ['delete task', () => as(who, http().delete(`/tasks/${p.second.id}`))],
      [
        'create link',
        () =>
          as(who, http().post('/dependencies')).send({
            fromTaskId: p.second.id,
            toTaskId: p.first.id,
          }),
      ],
      ['edit link', () => as(who, http().patch(`/dependencies/${p.link.id}`)).send({ lagDays: 2 })],
      ['delete link', () => as(who, http().delete(`/dependencies/${p.link.id}`))],
      [
        'create event',
        () =>
          as(who, http().post('/events')).send({
            projectId: p.project.id,
            name: 'E',
            color: '#e5484d',
            startDate: '2026-11-12',
            endDate: '2026-11-12',
          }),
      ],
      [
        'edit event',
        () => as(who, http().patch(`/events/${p.event.id}`)).send({ name: 'Renamed event' }),
      ],
      ['delete event', () => as(who, http().delete(`/events/${p.event.id}`))],
      ['undo', () => as(who, http().post(`/projects/${p.project.id}/undo`))],
      ['redo', () => as(who, http().post(`/projects/${p.project.id}/redo`))],
      ['restore a revision', () => as(who, http().post(`/revisions/${p.revisionId}/restore`))],
      ['restore a version', () => as(who, http().post(`/versions/${p.versionId}/restore`))],
    ] as const;

  it('refuses every change to the plan of an archived project, for owners and editors', async () => {
    const p = await plan();
    await as(ada, http().patch(`/projects/${p.project.id}/archive`)).expect(200);
    for (const who of [ada, eve]) {
      for (const [name, call] of planChanges(who, p)) {
        const response = await call();
        expect([name, response.status, (response.body as { message?: string }).message]).toEqual([
          name,
          403,
          ARCHIVED_MESSAGE,
        ]);
      }
    }
    // A viewer is still told what a viewer is told.
    const viewer = await as(vic, http().patch(`/tasks/${p.second.id}`)).send({ name: 'x' });
    expect(viewer.status).toBe(403);
    expect((viewer.body as { message: string }).message).toBe('You can only view this project');
    // Nothing changed.
    const tasks = (await as(ada, http().get(`/tasks?projectId=${p.project.id}`)).expect(200))
      .body as { name: string }[];
    expect(tasks.map((t) => t.name).sort()).toEqual(['First', 'Group', 'Second']);
  });

  it('still reads, renames, saves and copies versions, and manages members while archived', async () => {
    const p = await plan();
    await as(ada, http().patch(`/projects/${p.project.id}/archive`)).expect(200);
    for (const who of [ada, eve, vic]) {
      await as(who, http().get(`/projects/${p.project.id}`)).expect(200);
      await as(who, http().get(`/tasks?projectId=${p.project.id}`)).expect(200);
      await as(who, http().get(`/dependencies?projectId=${p.project.id}`)).expect(200);
      await as(who, http().get(`/events?projectId=${p.project.id}`)).expect(200);
      await as(who, http().get(`/projects/${p.project.id}/revisions`)).expect(200);
      await as(who, http().get(`/projects/${p.project.id}/undo`)).expect(200);
    }
    const name = `Renamed ${randomUUID()}`;
    const renamed = (
      await as(ada, http().patch(`/projects/${p.project.id}`))
        .send({ name })
        .expect(200)
    ).body as { name: string; archived: boolean };
    expect(renamed).toMatchObject({ name, archived: true });
    await as(eve, http().post(`/projects/${p.project.id}/versions`)).expect(201);
    await as(eve, http().patch(`/versions/${p.versionId}`))
      .send({ starred: true })
      .expect(200);
    const copy = (await as(vic, http().post(`/versions/${p.versionId}/copy`)).expect(201)).body as {
      id: string;
      archived: boolean;
    };
    // The copy is a new, active project of Vic's: it can be changed.
    await as(vic, http().post('/tasks'))
      .send({
        projectId: copy.id,
        name: 'Mine',
        color: '#2a78d6',
        startDate: '2026-11-02',
        endDate: '2026-11-03',
      })
      .expect(201);
    const member = (await as(ada, http().get(`/projects/${p.project.id}/members`)).expect(200))
      .body as { id: string; role: string }[];
    const vicRow = member.find((m) => m.role === 'viewer')!;
    await as(ada, http().patch(`/members/${vicRow.id}`))
      .send({ role: 'editor' })
      .expect(200);
  });

  it('reopening makes the plan editable again', async () => {
    const p = await plan();
    await as(ada, http().patch(`/projects/${p.project.id}/archive`)).expect(200);
    await as(eve, http().patch(`/tasks/${p.second.id}`))
      .send({ name: 'Nope' })
      .expect(403);
    // Only an owner reopens.
    await as(eve, http().patch(`/projects/${p.project.id}/reopen`)).expect(403);
    await as(ada, http().patch(`/projects/${p.project.id}/reopen`)).expect(200);
    await as(eve, http().patch(`/tasks/${p.second.id}`))
      .send({ name: 'Yes' })
      .expect(200);
    await as(eve, http().patch(`/events/${p.event.id}`))
      .send({ name: 'Moved' })
      .expect(200);
    await as(eve, http().delete(`/dependencies/${p.link.id}`)).expect(204);
  });

  it('an archived project can be deleted by its owner, with everything in it', async () => {
    const p = await plan();
    await as(ada, http().patch(`/projects/${p.project.id}/archive`)).expect(200);
    await as(eve, http().delete(`/projects/${p.project.id}`)).expect(403);
    await as(ada, http().delete(`/projects/${p.project.id}`)).expect(200);
    await as(ada, http().get(`/projects/${p.project.id}`)).expect(404);
    await as(ada, http().get(`/tasks?projectId=${p.project.id}`)).expect(404);
    await as(eve, http().get(`/projects/${p.project.id}`)).expect(404);
  });
});
