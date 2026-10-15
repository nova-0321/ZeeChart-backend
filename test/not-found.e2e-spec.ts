import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/validation.js';
import { deleteTestAccounts } from './cleanup.js';

// One 404 shape (#58): "<Thing> not found", never the id. A row in someone else's project gets
// exactly the answer a row that doesn't exist gets, so the two can't be told apart.

interface Account {
  token: string;
}
interface Row {
  id: string;
}

describe('404 answers (e2e)', () => {
  let app: INestApplication;
  let owner: Account;
  let stranger: Account;
  /** The owner's rows, one of each kind. */
  const rows: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const as = (who: Account, call: request.Test) => call.set('Authorization', `Bearer ${who.token}`);
  const signUp = async (name: string) => ({
    token: (
      (
        await http()
          .post('/auth/signup')
          .send({
            name,
            email: `zz404-${name}-${randomUUID()}@example.com`,
            password: 'pass-word-1',
          })
          .expect(201)
      ).body as { accessToken: string }
    ).accessToken,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
    owner = await signUp('owner');
    stranger = await signUp('stranger');

    const post = async (path: string, body: object) =>
      ((await as(owner, http().post(path)).send(body).expect(201)).body as Row).id;
    const task = { color: '#2a78d6', startDate: '2026-11-02', endDate: '2026-11-03' };
    rows.project = await post('/projects', { name: `zz404 ${randomUUID()}` });
    rows.task = await post('/tasks', { ...task, projectId: rows.project, name: 'A' });
    const other = await post('/tasks', { ...task, projectId: rows.project, name: 'B' });
    rows.link = await post('/dependencies', { fromTaskId: rows.task, toTaskId: other });
    rows.event = await post('/events', { ...task, projectId: rows.project, name: 'Launch' });
    rows.version = await post(`/projects/${rows.project}/versions`, {});
    const invited = (
      await as(owner, http().post(`/projects/${rows.project}/invitations`))
        .send({ email: `zz404-invitee-${randomUUID()}@example.com` })
        .expect(201)
    ).body as { invitation: Row };
    rows.invitation = invited.invitation.id;
    rows.member = (
      (await as(owner, http().get(`/projects/${rows.project}/members`)).expect(200)).body as Row[]
    )[0]!.id;
    rows.revision = (
      (await as(owner, http().get(`/projects/${rows.project}/revisions`)).expect(200)).body as Row[]
    )[0]!.id;
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zz404-');
    await app.close();
  });

  /** Each route about one row, the kind of row its id is, and what its 404 says. */
  const ROUTES: [
    method: 'get' | 'patch' | 'delete' | 'post',
    path: string,
    kind: string,
    says: string,
    body?: object,
  ][] = [
    ['patch', '/projects/:id', 'project', 'Project not found', { name: 'X' }],
    ['get', '/projects/:id/members', 'project', 'Project not found'],
    ['patch', '/tasks/:id', 'task', 'Task not found', { name: 'X' }],
    ['patch', '/dependencies/:id', 'link', 'Link not found', { lagDays: 1 }],
    ['patch', '/events/:id', 'event', 'Event not found', { name: 'X' }],
    ['patch', '/members/:id', 'member', 'Member not found', { role: 'editor' }],
    ['delete', '/invitations/:id', 'invitation', 'Invitation not found'],
    ['get', '/versions/:id', 'version', 'Version not found'],
    ['post', '/revisions/:id/restore', 'revision', 'Revision not found'],
  ];

  it.each(ROUTES)(
    '%s %s: "%s" for one that does not exist',
    async (method, path, _kind, says, body) => {
      const response = await as(owner, http()[method](path.replace(':id', randomUUID())))
        .send(body)
        .expect(404);
      expect((response.body as { message: string }).message).toBe(says);
    },
  );

  it.each(ROUTES)(
    '%s %s: the same for one in a project you are not in',
    async (method, path, kind, says, body) => {
      const response = await as(stranger, http()[method](path.replace(':id', rows[kind]!)))
        .send(body)
        .expect(404);
      expect((response.body as { message: string }).message).toBe(says);
    },
  );

  it('a project you are not in, named in a body: "Project not found"', async () => {
    const response = await as(stranger, http().post('/tasks'))
      .send({
        projectId: rows.project,
        name: 'X',
        color: '#2a78d6',
        startDate: '2026-11-02',
        endDate: '2026-11-03',
      })
      .expect(404);
    expect((response.body as { message: string }).message).toBe('Project not found');
  });
});
