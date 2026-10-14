import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/validation.js';

// Scratch probe (deleted after use): does a burst of concurrent writes on ONE instance, larger than
// the connection pool (node-postgres default max 10), still complete?

const BURST = 15;
const LIMIT_MS = 15_000;

describe('probe: pool burst', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
  });

  const signUp = async () =>
    (
      (
        await request(app.getHttpServer())
          .post('/auth/signup')
          .send({
            name: 'Probe',
            email: `zzprobe-${randomUUID()}@example.com`,
            password: 'pass-word-1',
          })
          .expect(201)
      ).body as { accessToken: string }
    ).accessToken;

  const as = (token: string) => ({
    post: (path: string, body: object) =>
      request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) =>
      request(app.getHttpServer()).patch(path).set('Authorization', `Bearer ${token}`).send(body),
  });

  const projectWithTask = async (token: string) => {
    const api = as(token);
    const project = (await api.post('/projects', { name: `Probe ${randomUUID()}` }).expect(201))
      .body as { id: string };
    const task = (
      await api
        .post('/tasks', {
          projectId: project.id,
          name: 'T',
          color: '#2a78d6',
          startDate: '2026-11-02',
          endDate: '2026-11-03',
        })
        .expect(201)
    ).body as { id: string };
    return { projectId: project.id, taskId: task.id };
  };

  const settleWithin = async (calls: Promise<request.Response>[]) => {
    let done = 0;
    const tracked = calls.map((call) =>
      call.then((response) => {
        done++;
        return response.status;
      }),
    );
    const outcome = await Promise.race([
      Promise.all(tracked).then((statuses) => ({ hung: false, statuses })),
      new Promise<{ hung: true; statuses: number[] }>((resolve) =>
        setTimeout(() => resolve({ hung: true, statuses: [] }), LIMIT_MS),
      ),
    ]);
    return { ...outcome, done };
  };

  it(`${BURST} concurrent writes to ONE project on one instance`, async () => {
    const token = await signUp();
    const { taskId } = await projectWithTask(token);
    const api = as(token);
    const started = performance.now();
    const result = await settleWithin(
      Array.from({ length: BURST }, (_, i) => api.patch(`/tasks/${taskId}`, { progress: i })),
    );
    console.log('ONE PROJECT', {
      ...result,
      ms: Math.round(performance.now() - started),
    });
    expect(result.hung).toBe(false);
  }, 40_000);

  it(`${BURST} concurrent writes to ${BURST} DIFFERENT projects on one instance`, async () => {
    const token = await signUp();
    const targets = [];
    for (let i = 0; i < BURST; i++) targets.push(await projectWithTask(token));
    const api = as(token);
    const started = performance.now();
    const result = await settleWithin(
      targets.map(({ taskId }, i) => api.patch(`/tasks/${taskId}`, { progress: i })),
    );
    console.log('DIFFERENT PROJECTS', {
      ...result,
      ms: Math.round(performance.now() - started),
    });
    expect(result.hung).toBe(false);
  }, 60_000);
});
