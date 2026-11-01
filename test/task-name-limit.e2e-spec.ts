import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/validation.js';
import { deleteTestAccounts } from './cleanup.js';

// A task name is at most 40 characters (#81), checked whenever a name is set or changed. Tasks
// named before the limit keep their names: an edit that doesn't send the name still saves.

describe('Task name limit (e2e)', () => {
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
            name: 'Names',
            email: `zzname-${randomUUID()}@example.com`,
            password: 'pass-word-1',
          })
          .expect(201)
      ).body as { accessToken: string }
    ).accessToken;
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzname-');
    await app.close();
  });

  const project = async () =>
    (
      await as(http().post('/projects'))
        .send({ name: `Names ${randomUUID()}` })
        .expect(201)
    ).body as { id: string };

  const taskBody = (projectId: string, name: string) => ({
    projectId,
    name,
    color: '#2a78d6',
    startDate: '2026-11-02',
    endDate: '2026-11-04',
  });

  it('creates a task named with exactly 40 characters', async () => {
    const { id: projectId } = await project();
    const created = await as(http().post('/tasks'))
      .send(taskBody(projectId, 'x'.repeat(40)))
      .expect(201);
    expect((created.body as { name: string }).name).toBe('x'.repeat(40));
  });

  it('refuses to create a task named with 41 characters, with the standard 400', async () => {
    const { id: projectId } = await project();
    const refused = await as(http().post('/tasks'))
      .send(taskBody(projectId, 'x'.repeat(41)))
      .expect(400);
    expect(refused.body).toMatchObject({ statusCode: 400 });
    expect(messageOf(refused)).toMatch(/name.*40/);
    const tasks = (await as(http().get('/tasks')).query({ projectId }).expect(200))
      .body as unknown[];
    expect(tasks).toHaveLength(0);
  });

  it('refuses to rename a task to 41 characters, and keeps the old name', async () => {
    const { id: projectId } = await project();
    const task = (await as(http().post('/tasks')).send(taskBody(projectId, 'Short')).expect(201))
      .body as { id: string };
    const refused = await as(http().patch(`/tasks/${task.id}`))
      .send({ name: 'y'.repeat(41) })
      .expect(400);
    expect(messageOf(refused)).toMatch(/name.*40/);
    const tasks = (await as(http().get('/tasks')).query({ projectId }).expect(200)).body as {
      id: string;
      name: string;
    }[];
    expect(tasks.find((t) => t.id === task.id)?.name).toBe('Short');
  });

  it('still saves a task named before the limit when the edit does not send its name', async () => {
    const { id: projectId } = await project();
    const task = (
      await as(http().post('/tasks')).send(taskBody(projectId, 'Will be long')).expect(201)
    ).body as { id: string };
    // A name from before the limit: written straight to the table, as the API now refuses it.
    const longName = 'z'.repeat(60);
    await app
      .get(DataSource)
      .query(`UPDATE "tasks" SET "name" = $2 WHERE "id" = $1`, [task.id, longName]);

    const saved = await as(http().patch(`/tasks/${task.id}`))
      .send({ progress: 30, description: 'Edited' })
      .expect(200);
    expect(saved.body).toMatchObject({ name: longName, progress: 30, description: 'Edited' });
  });
});
