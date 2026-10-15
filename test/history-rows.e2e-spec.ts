import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/validation.js';
import { deleteTestAccounts } from './cleanup.js';

/** An index past the end of any list: /move puts the task last (as the removed /parent did). */
const LAST = 10_000;

// What undo, restoring from the history and restoring a version write back, kind of row by kind of
// row. Since #55 each kind is written by the domain that owns it (task-rows.ts, link-rows.ts,
// event-rows.ts, project-rows.ts, membership.ts, TaskService, EventsService); these are the cases
// the other history tests don't reach.

interface Account {
  token: string;
  id: string;
  email: string;
}
interface TaskBody {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  order: number;
  priority: string;
  startDate: string;
  endDate: string;
}
interface RevisionBody {
  id: string;
  entityId: string;
  entityType: string;
  action: string;
  version: number;
}

describe('What the history writes back (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const as = (account: Account, call: request.Test) =>
    call.set('Authorization', `Bearer ${account.token}`);

  const signUp = async (name: string): Promise<Account> => {
    const body = (
      await http()
        .post('/auth/signup')
        .send({ name, email: `zzrows-${randomUUID()}@example.com`, password: 'pass-word-1' })
        .expect(201)
    ).body as { accessToken: string; user: { id: string; email: string } };
    return { token: body.accessToken, id: body.user.id, email: body.user.email };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzrows-');
    await app.close();
  });

  /** A project of a new owner's; with `withEditor`, Bob is an editor of it too. */
  const setUp = async (withEditor = false) => {
    const owner = await signUp('Olive');
    const project = (
      await as(owner, http().post('/projects'))
        .send({ name: `zzrows ${randomUUID()}` })
        .expect(201)
    ).body as { id: string; name: string };
    const bob = withEditor ? await signUp('Bob') : null;
    if (bob) {
      await as(owner, http().post(`/projects/${project.id}/invitations`))
        .send({ email: bob.email })
        .expect(201);
    }
    return { owner, bob: bob!, projectId: project.id, projectName: project.name };
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
  const tasksOf = async (who: Account, projectId: string) =>
    (await as(who, http().get(`/tasks?projectId=${projectId}`)).expect(200)).body as TaskBody[];
  const linksOf = async (who: Account, projectId: string) =>
    (await as(who, http().get(`/dependencies?projectId=${projectId}`)).expect(200)).body as {
      fromTaskId: string;
      toTaskId: string;
    }[];
  const history = async (who: Account, projectId: string) =>
    (await as(who, http().get(`/projects/${projectId}/revisions`)).expect(200))
      .body as RevisionBody[];
  const undo = (who: Account, projectId: string) =>
    as(who, http().post(`/projects/${projectId}/undo`));
  const saveVersion = async (who: Account, projectId: string) =>
    (await as(who, http().post(`/projects/${projectId}/versions`)).expect(201)).body as {
      id: string;
    };
  const restoreVersion = (who: Account, id: string) =>
    as(who, http().post(`/versions/${id}/restore`)).expect(200);
  const message = (response: request.Response) => (response.body as { message: string }).message;

  describe('restoring a version', () => {
    it('puts the tasks back in their order, and takes away links and events made since', async () => {
      const { owner, projectId } = await setUp();
      const a = await newTask(owner, projectId, { name: 'A' });
      const b = await newTask(owner, projectId, {
        name: 'B',
        startDate: '2026-11-09',
        endDate: '2026-11-10',
      });
      const saved = await saveVersion(owner, projectId);
      // Since: B moved first, and A linked to B.
      await as(owner, http().patch(`/tasks/${b.id}/move`))
        .send({ parentId: null, index: 0 })
        .expect(200);
      await as(owner, http().post('/dependencies'))
        .send({ fromTaskId: a.id, toTaskId: b.id })
        .expect(201);
      await as(owner, http().post('/events'))
        .send({
          projectId,
          name: 'Freeze',
          color: '#e5484d',
          startDate: '2026-11-12',
          endDate: '2026-11-12',
        })
        .expect(201);

      await restoreVersion(owner, saved.id);

      expect((await tasksOf(owner, projectId)).map((t) => [t.name, t.order])).toEqual([
        ['A', 1],
        ['B', 2],
      ]);
      expect(await linksOf(owner, projectId)).toEqual([]);
      expect(
        (await as(owner, http().get(`/events?projectId=${projectId}`)).expect(200)).body,
      ).toEqual([]);
    });
  });

  describe('undo', () => {
    it('of a priority change puts the old priority back (the history follows every field)', async () => {
      const { owner, projectId } = await setUp();
      const task = await newTask(owner, projectId, { name: 'A', priority: 'low' });
      await as(owner, http().patch(`/tasks/${task.id}`))
        .send({ priority: 'high' })
        .expect(200);

      await undo(owner, projectId).expect(200);

      expect((await tasksOf(owner, projectId)).map((t) => [t.name, t.priority])).toEqual([
        ['A', 'low'],
      ]);
    });

    it('of a rename puts the old name back', async () => {
      const { owner, projectId, projectName } = await setUp();
      await as(owner, http().patch(`/projects/${projectId}`))
        .send({ name: `${projectName} v2` })
        .expect(200);
      await undo(owner, projectId).expect(200);
      const project = (await as(owner, http().get(`/projects/${projectId}`)).expect(200)).body as {
        name: string;
      };
      expect(project.name).toBe(projectName);
    });

    it('of a rename is refused when an owner has another project of that name now', async () => {
      const { owner, projectId, projectName } = await setUp();
      await as(owner, http().patch(`/projects/${projectId}`))
        .send({ name: `${projectName} v2` })
        .expect(200);
      // The old name is free again: they give it to another project of theirs.
      await as(owner, http().post('/projects')).send({ name: projectName }).expect(201);

      const refused = await undo(owner, projectId).expect(409);
      expect(message(refused)).toBe(
        `Can't undo: an owner of this project has another one called “${projectName}” now`,
      );
    });

    it('of a deletion leaves out a link to a task that someone else deleted since', async () => {
      const { owner, bob, projectId } = await setUp(true);
      const a = await newTask(owner, projectId, { name: 'A' });
      const b = await newTask(owner, projectId, {
        name: 'B',
        startDate: '2026-11-09',
        endDate: '2026-11-10',
      });
      await as(owner, http().post('/dependencies'))
        .send({ fromTaskId: a.id, toTaskId: b.id })
        .expect(201);
      await as(owner, http().delete(`/tasks/${a.id}`)).expect(204);
      await as(bob, http().delete(`/tasks/${b.id}`)).expect(204);

      await undo(owner, projectId).expect(200);

      expect((await tasksOf(owner, projectId)).map((t) => t.name)).toEqual(['A']);
      expect(await linksOf(owner, projectId)).toEqual([]);
    });

    it('numbers two tasks again when the one it brings back takes a place someone else took', async () => {
      const { owner, bob, projectId } = await setUp(true);
      const a = await newTask(owner, projectId, { name: 'A' });
      const b = await newTask(owner, projectId, { name: 'B' });
      await as(owner, http().delete(`/tasks/${a.id}`)).expect(204);
      // Bob puts B first: it takes place 1, which A had.
      await as(bob, http().patch(`/tasks/${b.id}/move`))
        .send({ parentId: null, index: 0 })
        .expect(200);

      await undo(owner, projectId).expect(200);

      const tasks = await tasksOf(owner, projectId);
      expect(tasks.map((t) => t.order).sort()).toEqual([1, 2]);
      // The task it brought back first, on the place they both had.
      expect(tasks.map((t) => t.name)).toEqual(['A', 'B']);
    });

    it('is refused when it would put a task in a group that is a plain task now', async () => {
      const { owner, bob, projectId } = await setUp(true);
      const group = await newTask(owner, projectId, { name: 'Phase', type: 'group' });
      const task = await newTask(owner, projectId, { name: 'Build', parentId: group.id });
      // Out of the group (the undo would put it back in), then Bob makes the empty group a task.
      await as(owner, http().patch(`/tasks/${task.id}/move`))
        .send({ parentId: null, index: LAST })
        .expect(200);
      await as(bob, http().patch(`/tasks/${group.id}/type`))
        .send({ type: 'task' })
        .expect(200);

      const refused = await undo(owner, projectId).expect(409);
      expect(message(refused)).toBe("Can't undo: the groups were changed since");
      expect((await tasksOf(owner, projectId)).find((t) => t.id === task.id)!.parentId).toBeNull();
    });
  });

  describe('restoring from the history', () => {
    it('a task into a group that is a plain task now: it stays where it is', async () => {
      const { owner, projectId } = await setUp();
      const group = await newTask(owner, projectId, { name: 'Phase', type: 'group' });
      const task = await newTask(owner, projectId, { name: 'Build', parentId: group.id });
      await as(owner, http().patch(`/tasks/${task.id}/move`))
        .send({ parentId: null, index: LAST })
        .expect(200);
      await as(owner, http().patch(`/tasks/${group.id}/type`))
        .send({ type: 'task' })
        .expect(200);
      const inGroup = (await history(owner, projectId)).find(
        (r) => r.entityId === task.id && r.action === 'create',
      )!;

      const result = (await as(owner, http().post(`/revisions/${inGroup.id}/restore`)).expect(200))
        .body as { skipped: string[] };

      expect(result.skipped).toEqual([
        'its group (gone, no longer a group, or in a loop of groups): it stays where it is',
      ]);
      expect((await tasksOf(owner, projectId)).find((t) => t.id === task.id)!.parentId).toBeNull();
    });

    it('a deleted task back into its group: the group fits it again (a group is the days of its tasks)', async () => {
      const { owner, projectId } = await setUp();
      const group = await newTask(owner, projectId, { name: 'Phase', type: 'group' });
      const task = await newTask(owner, projectId, { name: 'Build', parentId: group.id });
      await as(owner, http().delete(`/tasks/${task.id}`)).expect(204);
      // The empty group moved on to other days meanwhile.
      await as(owner, http().patch(`/tasks/${group.id}`))
        .send({ startDate: '2026-11-20', endDate: '2026-11-21' })
        .expect(200);
      const deletion = (await history(owner, projectId)).find(
        (r) => r.entityId === task.id && r.action === 'delete',
      )!;

      await as(owner, http().post(`/revisions/${deletion.id}/restore`)).expect(200);

      const phase = (await tasksOf(owner, projectId)).find((t) => t.id === group.id)!;
      expect([phase.startDate.slice(0, 10), phase.endDate.slice(0, 10)]).toEqual([
        '2026-11-02',
        '2026-11-06',
      ]);
    });

    it('an event that is still there is written over, not made a second time', async () => {
      const { owner, projectId } = await setUp();
      const event = (
        await as(owner, http().post('/events'))
          .send({
            projectId,
            name: 'Freeze',
            color: '#e5484d',
            startDate: '2026-11-12',
            endDate: '2026-11-12',
          })
          .expect(201)
      ).body as { id: string };
      await as(owner, http().patch(`/events/${event.id}`))
        .send({ name: 'Freeze moved' })
        .expect(200);
      const created = (await history(owner, projectId)).find(
        (r) => r.entityId === event.id && r.action === 'create',
      )!;

      await as(owner, http().post(`/revisions/${created.id}/restore`)).expect(200);

      const events = (await as(owner, http().get(`/events?projectId=${projectId}`)).expect(200))
        .body as { id: string; name: string }[];
      expect(events.map((e) => [e.id, e.name])).toEqual([[event.id, 'Freeze']]);
    });
  });
});
