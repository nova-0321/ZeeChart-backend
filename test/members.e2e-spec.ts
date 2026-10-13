import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { LAST_OWNER } from '../src/members/members.service.js';
import { deleteTestAccounts } from './cleanup.js';
import { createValidationPipe } from '../src/common/validation.js';

// Members and roles: a viewer reads, an editor also changes tasks, links and events, an owner also
// changes the project and its members. A project always keeps at least one owner.

interface Account {
  token: string;
  id: string;
  email: string;
}
interface MemberBody {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  addedById: string | null;
}

describe('Members (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const as = (account: Account, call: request.Test) =>
    call.set('Authorization', `Bearer ${account.token}`);

  const signUp = async (name: string): Promise<Account> => {
    const body = (
      await http()
        .post('/auth/signup')
        .send({ name, email: `zzmem-${randomUUID()}@example.com`, password: 'pass-word-1' })
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
    await deleteTestAccounts(app, 'zzmem-');
    await app.close();
  });

  /** A project of a new owner's, with a task in it. */
  const setUp = async () => {
    const owner = await signUp('Olive');
    const project = (
      await as(owner, http().post('/projects'))
        .send({ name: `zzmem ${randomUUID()}` })
        .expect(201)
    ).body as { id: string };
    const task = (
      await as(owner, http().post('/tasks'))
        .send({
          projectId: project.id,
          name: 'First',
          color: '#2a78d6',
          startDate: '2026-11-02',
          endDate: '2026-11-06',
        })
        .expect(201)
    ).body as { id: string };
    return { owner, projectId: project.id, taskId: task.id };
  };
  const add = (owner: Account, projectId: string, body: object) =>
    as(owner, http().post(`/projects/${projectId}/invitations`)).send(body);
  const list = async (who: Account, projectId: string) =>
    (await as(who, http().get(`/projects/${projectId}/members`)).expect(200)).body as MemberBody[];

  it('adds someone by email (any case, spaces trimmed), as an editor by default', async () => {
    const { owner, projectId } = await setUp();
    const ed = await signUp('Ed');
    const added = (
      await add(owner, projectId, { email: `  ${ed.email.toUpperCase()} ` }).expect(201)
    ).body.member as MemberBody;
    expect(added).toMatchObject({ userId: ed.id, name: 'Ed', role: 'editor', addedById: owner.id });
    expect((await list(owner, projectId)).map((m) => [m.name, m.role])).toEqual([
      ['Olive', 'owner'],
      ['Ed', 'editor'],
    ]);
    // They see it in their projects, with their role, and who added them.
    const theirs = (await as(ed, http().get('/projects')).expect(200)).body as {
      id: string;
      role: string;
      addedBy: { id: string; name: string } | null;
      joinedAt: string;
    }[];
    const seen = theirs.find((p) => p.id === projectId);
    expect(seen).toMatchObject({ role: 'editor', addedBy: { id: owner.id, name: 'Olive' } });
    expect(Date.parse(seen!.joinedAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('refuses someone already in (409) and bad input (400); an unknown email gets a link', async () => {
    const { owner, projectId } = await setUp();
    const ed = await signUp('Ed');
    // No account: an invitation with a link, not a 404 (the old direct add said "no one has
    // signed up with this email", so emails could be looked up).
    const unknown = (
      await add(owner, projectId, { email: `zzmem-nobody-${randomUUID()}@example.com` }).expect(201)
    ).body as { status: string };
    expect(unknown.status).toBe('invited');
    await add(owner, projectId, { email: ed.email }).expect(201);
    await add(owner, projectId, { email: ed.email }).expect(409);
    await add(owner, projectId, { email: owner.email }).expect(409);
    await add(owner, projectId, { email: 'not-an-email' }).expect(400);
    await add(owner, projectId, { email: ed.email, role: 'admin' }).expect(400);
  });

  it('has no direct "add by email" route: invitations are the only way in', async () => {
    const { owner, projectId } = await setUp();
    const ed = await signUp('Ed');
    await as(owner, http().post(`/projects/${projectId}/members`))
      .send({ email: ed.email })
      .expect(404);
    expect((await list(owner, projectId)).map((m) => m.name)).toEqual(['Olive']);
  });

  it('a viewer reads everything and changes nothing (403)', async () => {
    const { owner, projectId, taskId } = await setUp();
    const viewer = await signUp('Vi');
    await add(owner, projectId, { email: viewer.email, role: 'viewer' }).expect(201);
    await as(viewer, http().get(`/projects/${projectId}`)).expect(200);
    await as(viewer, http().get(`/tasks?projectId=${projectId}`)).expect(200);
    await as(viewer, http().get(`/dependencies?projectId=${projectId}`)).expect(200);
    await as(viewer, http().get(`/events?projectId=${projectId}`)).expect(200);
    await as(viewer, http().get(`/projects/${projectId}/members`)).expect(200);
    const refused = await as(viewer, http().patch(`/tasks/${taskId}`)).send({ name: 'x' });
    expect(refused.status).toBe(403);
    expect((refused.body as { message: string }).message).toBe('You can only view this project');
    await as(viewer, http().delete(`/tasks/${taskId}`)).expect(403);
    await as(viewer, http().patch(`/projects/${projectId}`))
      .send({ name: 'x' })
      .expect(403);
  });

  it('an editor changes tasks, but not the project or its members', async () => {
    const { owner, projectId, taskId } = await setUp();
    const ed = await signUp('Ed');
    const other = await signUp('Other');
    await add(owner, projectId, { email: ed.email }).expect(201);
    await as(ed, http().patch(`/tasks/${taskId}`))
      .send({ name: 'Renamed' })
      .expect(200);
    const refused = await as(ed, http().patch(`/projects/${projectId}/archive`));
    expect(refused.status).toBe(403);
    expect((refused.body as { message: string }).message).toBe(
      'Only an owner of this project can do this',
    );
    await as(ed, http().delete(`/projects/${projectId}`)).expect(403);
    await add(ed, projectId, { email: other.email }).expect(403);
    const [ownerRow] = await list(owner, projectId);
    await as(ed, http().patch(`/members/${ownerRow!.id}`))
      .send({ role: 'viewer' })
      .expect(403);
    await as(ed, http().delete(`/members/${ownerRow!.id}`)).expect(403);
  });

  it('owners change roles; the change takes effect at once', async () => {
    const { owner, projectId, taskId } = await setUp();
    const ed = await signUp('Ed');
    const row = (await add(owner, projectId, { email: ed.email }).expect(201)).body
      .member as MemberBody;
    const changed = (
      await as(owner, http().patch(`/members/${row.id}`))
        .send({ role: 'viewer' })
        .expect(200)
    ).body as MemberBody;
    expect(changed.role).toBe('viewer');
    await as(ed, http().patch(`/tasks/${taskId}`))
      .send({ name: 'x' })
      .expect(403);
    await as(owner, http().patch(`/members/${row.id}`))
      .send({ role: 'owner' })
      .expect(200);
    // A second owner can do what owners do, members included.
    await as(ed, http().patch(`/projects/${projectId}`))
      .send({ description: 'x' })
      .expect(200);
    await as(owner, http().patch(`/members/${row.id}`))
      .send({ role: 'nope' })
      .expect(400);
  });

  it('the last owner can be neither demoted nor removed', async () => {
    const { owner, projectId } = await setUp();
    const [ownerRow] = await list(owner, projectId);
    const demoted = await as(owner, http().patch(`/members/${ownerRow!.id}`)).send({
      role: 'editor',
    });
    expect(demoted.status).toBe(409);
    expect((demoted.body as { message: string }).message).toBe(LAST_OWNER);
    await as(owner, http().delete(`/members/${ownerRow!.id}`)).expect(409);
    // Setting the role it already has is fine.
    await as(owner, http().patch(`/members/${ownerRow!.id}`))
      .send({ role: 'owner' })
      .expect(200);

    // With a second owner, the first may step down, and then the second is the last.
    const ann = await signUp('Ann');
    const annRow = (await add(owner, projectId, { email: ann.email, role: 'owner' }).expect(201))
      .body.member as MemberBody;
    await as(owner, http().patch(`/members/${ownerRow!.id}`))
      .send({ role: 'viewer' })
      .expect(200);
    await as(ann, http().delete(`/members/${annRow.id}`)).expect(409);
  });

  it('two owners demoting each other at once: one wins, the project keeps an owner', async () => {
    const { owner, projectId } = await setUp();
    const ann = await signUp('Ann');
    const annRow = (await add(owner, projectId, { email: ann.email, role: 'owner' }).expect(201))
      .body.member as MemberBody;
    const ownerRow = (await list(owner, projectId)).find((m) => m.userId === owner.id)!;
    const answers = await Promise.all([
      as(owner, http().patch(`/members/${annRow.id}`)).send({ role: 'editor' }),
      as(ann, http().patch(`/members/${ownerRow.id}`)).send({ role: 'editor' }),
    ]);
    const statuses = answers.map((r) => r.status).sort();
    // The loser is refused: 409 when the other demotion committed first, or 403 when it was
    // demoted itself before its own request was checked.
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    const owners = (await list(owner, projectId)).filter((m) => m.role === 'owner');
    expect(owners).toHaveLength(1);
  });

  it('someone removed loses the project at once (404, as if it never existed)', async () => {
    const { owner, projectId, taskId } = await setUp();
    const ed = await signUp('Ed');
    const row = (await add(owner, projectId, { email: ed.email }).expect(201)).body
      .member as MemberBody;
    await as(owner, http().delete(`/members/${row.id}`)).expect(204);
    await as(ed, http().get(`/projects/${projectId}`)).expect(404);
    await as(ed, http().patch(`/tasks/${taskId}`))
      .send({ name: 'x' })
      .expect(404);
    const theirs = (await as(ed, http().get('/projects')).expect(200)).body as { id: string }[];
    expect(theirs.map((p) => p.id)).not.toContain(projectId);
    // Removed twice: it is gone.
    await as(owner, http().delete(`/members/${row.id}`)).expect(404);
  });

  it("members of someone else's project can't be seen or changed (404)", async () => {
    const { owner, projectId } = await setUp();
    const stranger = await signUp('Stranger');
    const [ownerRow] = await list(owner, projectId);
    await as(stranger, http().get(`/projects/${projectId}/members`)).expect(404);
    await as(stranger, http().patch(`/members/${ownerRow!.id}`))
      .send({ role: 'viewer' })
      .expect(404);
    await as(stranger, http().delete(`/members/${ownerRow!.id}`)).expect(404);
    await as(stranger, http().patch(`/members/${randomUUID()}`))
      .send({ role: 'viewer' })
      .expect(404);
    await as(stranger, http().patch('/members/not-a-uuid')).send({ role: 'viewer' }).expect(400);
  });

  it('a project deleted by its owner takes its members with it', async () => {
    const { owner, projectId } = await setUp();
    const ed = await signUp('Ed');
    await add(owner, projectId, { email: ed.email }).expect(201);
    await as(owner, http().delete(`/projects/${projectId}`)).expect(200);
    const theirs = (await as(ed, http().get('/projects')).expect(200)).body as { id: string }[];
    expect(theirs.map((p) => p.id)).not.toContain(projectId);
  });
});
