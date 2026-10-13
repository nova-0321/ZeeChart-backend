import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/validation.js';
import { deleteTestAccounts } from './cleanup.js';

// A field a route doesn't take is refused (400, naming it) instead of quietly dropped: before, a
// request with one answered 200 and changed nothing.

describe('Unknown fields (e2e)', () => {
  let app: INestApplication;
  let token: string;
  const http = () => request(app.getHttpServer());
  const as = (call: request.Test) => call.set('Authorization', `Bearer ${token}`);
  const messageOf = (response: request.Response) =>
    ([] as string[]).concat((response.body as { message: string | string[] }).message).join(' ');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
    token = (
      (
        await http()
          .post('/auth/signup')
          .send({
            name: 'Val',
            email: `zzval-${randomUUID()}@example.com`,
            password: 'pass-word-1',
          })
          .expect(201)
      ).body as { accessToken: string }
    ).accessToken;
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzval-');
    await app.close();
  });

  const project = async () =>
    (
      await as(http().post('/projects'))
        .send({ name: `Val ${randomUUID()}` })
        .expect(201)
    ).body as { id: string };

  it('refuses a field the update does not take, and changes nothing', async () => {
    const { id: projectId } = await project();
    const group = (
      await as(http().post('/tasks'))
        .send({
          projectId,
          name: 'Group',
          type: 'group',
          color: '#2a78d6',
          startDate: '2026-11-02',
          endDate: '2026-11-06',
        })
        .expect(201)
    ).body as { id: string };
    const task = (
      await as(http().post('/tasks'))
        .send({
          projectId,
          name: 'Task',
          color: '#2a78d6',
          startDate: '2026-11-02',
          endDate: '2026-11-03',
        })
        .expect(201)
    ).body as { id: string };

    // parentId has a route of its own (PATCH /tasks/:id/parent): here it was silently ignored.
    const refused = await as(http().patch(`/tasks/${task.id}`))
      .send({ name: 'Renamed', parentId: group.id })
      .expect(400);
    expect(messageOf(refused)).toContain('property parentId should not exist');

    const tasks = (await as(http().get(`/tasks?projectId=${projectId}`)).expect(200)).body as {
      id: string;
      name: string;
      parentId: string | null;
    }[];
    // Nothing of that request was applied, not even its valid part.
    expect(tasks.find((t) => t.id === task.id)).toMatchObject({ name: 'Task', parentId: null });

    // The same change without the unknown field works.
    await as(http().patch(`/tasks/${task.id}`))
      .send({ name: 'Renamed' })
      .expect(200);
  });

  it('refuses an unknown field when creating, and a typo', async () => {
    const created = await as(http().post('/projects'))
      .send({ name: `Val ${randomUUID()}`, colour: 'red' })
      .expect(400);
    expect(messageOf(created)).toContain('property colour should not exist');

    const { id } = await project();
    const typo = await as(http().patch(`/projects/${id}`))
      .send({ nmae: 'x' })
      .expect(400);
    expect(messageOf(typo)).toContain('property nmae should not exist');
  });

  it('refuses an unknown query parameter, and takes the known ones', async () => {
    const { id } = await project();
    await as(http().get(`/projects/${id}/revisions?limit=5`)).expect(200);
    const refused = await as(http().get(`/projects/${id}/revisions?limit=5&sort=asc`)).expect(400);
    expect(messageOf(refused)).toContain('property sort should not exist');
  });
});
