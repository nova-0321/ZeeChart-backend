import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { deleteTestAccounts } from './cleanup.js';
import { createValidationPipe } from '../src/common/validation.js';

// Invitations (#20): an owner invites an email that has no account yet and gets a secret link. Only
// the link lets someone in: they open it, sign up or in, and accept; signing up with the invited
// email is not enough by itself.

interface Account {
  token: string;
  id: string;
  email: string;
}
interface InvitationBody {
  id: string;
  projectId: string;
  email: string;
  role: string;
  invitedById: string | null;
  invitedByName: string | null;
  expiresAt: string;
}
interface InviteBody {
  status: 'added' | 'invited';
  member: { id: string; userId: string; role: string } | null;
  invitation: InvitationBody | null;
  token: string | null;
}

describe('Invitations (e2e)', () => {
  let app: INestApplication;
  let db: DataSource;
  const http = () => request(app.getHttpServer());
  const as = (account: Account, call: request.Test) =>
    call.set('Authorization', `Bearer ${account.token}`);

  const newEmail = () => `zzinv-${randomUUID()}@example.com`;
  const signUp = async (name: string, email = newEmail()): Promise<Account> => {
    const body = (
      await http().post('/auth/signup').send({ name, email, password: 'pass-word-1' }).expect(201)
    ).body as { accessToken: string; user: { id: string; email: string } };
    return { token: body.accessToken, id: body.user.id, email: body.user.email };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
    db = app.get(DataSource);
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzinv-');
    await app.close();
  });

  const setUp = async () => {
    const owner = await signUp('Olive');
    const project = (
      await as(owner, http().post('/projects'))
        .send({ name: `zzinv ${randomUUID()}` })
        .expect(201)
    ).body as { id: string; name: string };
    return { owner, projectId: project.id, projectName: project.name };
  };
  const invite = (who: Account, projectId: string, body: object) =>
    as(who, http().post(`/projects/${projectId}/invitations`)).send(body);
  const invitations = async (who: Account, projectId: string) =>
    (await as(who, http().get(`/projects/${projectId}/invitations`)).expect(200))
      .body as InvitationBody[];
  const members = async (who: Account, projectId: string) =>
    (await as(who, http().get(`/projects/${projectId}/members`)).expect(200)).body as {
      userId: string;
      role: string;
      addedById: string | null;
    }[];
  const preview = (token: string) => http().post('/invites/preview').send({ token });
  const accept = (who: Account, token: string) =>
    as(who, http().post('/invites/accept')).send({ token });

  it('an email with no account: a link; signing up with the email is not enough, the link is', async () => {
    const { owner, projectId, projectName } = await setUp();
    const email = newEmail();
    const answer = (
      await invite(owner, projectId, { email: `  ${email.toUpperCase()} `, role: 'viewer' }).expect(
        201,
      )
    ).body as InviteBody;
    expect(answer).toMatchObject({
      status: 'invited',
      member: null,
      invitation: { email, role: 'viewer', invitedById: owner.id, invitedByName: 'Olive' },
    });
    expect(answer.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(new Date(answer.invitation!.expiresAt).getTime()).toBeGreaterThan(
      Date.now() + 13 * 24 * 3600 * 1000,
    );
    // The secret is not in the list (only its hash is stored).
    expect(JSON.stringify(await invitations(owner, projectId))).not.toContain(answer.token!);

    // Someone signs up with the invited email: that alone gives nothing.
    const sameEmail = await signUp('Impostor', email);
    expect((await members(owner, projectId)).some((m) => m.userId === sameEmail.id)).toBe(false);
    await as(sameEmail, http().get(`/projects/${projectId}`)).expect(404);

    // The link, opened by anyone (signed in or not): what it is for.
    const shown = (await preview(answer.token!).expect(200)).body as object;
    expect(shown).toMatchObject({ projectName, invitedByName: 'Olive', role: 'viewer' });

    // Whoever has the link and accepts it joins, with its role; the link is used up.
    const nia = await signUp('Nia');
    const joined = (await accept(nia, answer.token!).expect(200)).body as { projectId: string };
    expect(joined.projectId).toBe(projectId);
    expect((await members(owner, projectId)).find((m) => m.userId === nia.id)).toMatchObject({
      role: 'viewer',
      addedById: owner.id,
    });
    expect(await invitations(owner, projectId)).toEqual([]);
    await as(nia, http().get(`/tasks?projectId=${projectId}`)).expect(200);
    // Once only.
    await accept(sameEmail, answer.token!).expect(404);
    await preview(answer.token!).expect(404);
  });

  it('accepting needs a sign-in; a wrong or malformed link is a 404 or 400', async () => {
    const { owner, projectId } = await setUp();
    const { token } = (await invite(owner, projectId, { email: newEmail() }).expect(201))
      .body as InviteBody;
    await http().post('/invites/accept').send({ token }).expect(401);
    const someone = await signUp('Sam');
    await accept(someone, 'x'.repeat(43)).expect(404);
    await accept(someone, 'short').expect(400);
    await preview('short').expect(400);
    await http()
      .get(`/invites/${'y'.repeat(43)}`)
      .expect(404);
  });

  it('a new link stops the old one; an expired link is refused', async () => {
    const { owner, projectId } = await setUp();
    const first = (await invite(owner, projectId, { email: newEmail() }).expect(201))
      .body as InviteBody;
    const renewed = (
      await as(owner, http().post(`/invitations/${first.invitation!.id}/link`)).expect(201)
    ).body as { token: string; invitation: InvitationBody };
    expect(renewed.token).not.toBe(first.token);
    const bob = await signUp('Bob');
    await accept(bob, first.token!).expect(404);
    // Expired: refused, by the preview and by accepting.
    await db.query(
      `UPDATE "invitations" SET "expiresAt" = now() - interval '1 minute' WHERE "id" = $1`,
      [first.invitation!.id],
    );
    await preview(renewed.token).expect(404);
    await accept(bob, renewed.token).expect(404);
    expect((await members(owner, projectId)).some((m) => m.userId === bob.id)).toBe(false);
  });

  it('an email that has an account: added at once (no link)', async () => {
    const { owner, projectId } = await setUp();
    const bob = await signUp('Bob');
    const answer = (await invite(owner, projectId, { email: bob.email }).expect(201))
      .body as InviteBody;
    expect(answer).toMatchObject({
      status: 'added',
      invitation: null,
      token: null,
      member: { userId: bob.id, role: 'editor' },
    });
    await invite(owner, projectId, { email: bob.email }).expect(409);
  });

  it('the same email twice is a 409; a bad email a 400', async () => {
    const { owner, projectId } = await setUp();
    const email = newEmail();
    await invite(owner, projectId, { email }).expect(201);
    const again = await invite(owner, projectId, { email: email.toUpperCase() });
    expect([again.status, (again.body as { message: string }).message]).toEqual([
      409,
      `${email} is already invited to this project`,
    ]);
    await invite(owner, projectId, { email: 'not-an-email' }).expect(400);
    await invite(owner, projectId, { email, role: 'boss' }).expect(400);
  });

  it('owners invite, cancel and make links; members only see; strangers get 404', async () => {
    const { owner, projectId } = await setUp();
    const ed = await signUp('Ed');
    const stranger = await signUp('Stranger');
    await invite(owner, projectId, { email: ed.email }).expect(201);
    const email = newEmail();
    const { invitation, token } = (await invite(owner, projectId, { email }).expect(201))
      .body as InviteBody;

    expect((await invitations(ed, projectId)).map((i) => i.email)).toEqual([email]);
    await invite(ed, projectId, { email: newEmail() }).expect(403);
    await as(ed, http().delete(`/invitations/${invitation!.id}`)).expect(403);
    await as(ed, http().post(`/invitations/${invitation!.id}/link`)).expect(403);
    await as(stranger, http().get(`/projects/${projectId}/invitations`)).expect(404);
    await as(stranger, http().delete(`/invitations/${invitation!.id}`)).expect(404);
    await as(stranger, http().post(`/invitations/${invitation!.id}/link`)).expect(404);

    // Cancelled: the link stops working.
    await as(owner, http().delete(`/invitations/${invitation!.id}`)).expect(204);
    await as(owner, http().delete(`/invitations/${invitation!.id}`)).expect(404);
    await accept(stranger, token!).expect(404);
  });

  it('a link made by someone who is no longer an owner gives nothing, until an owner makes a new one', async () => {
    const { owner, projectId } = await setUp();
    const co = await signUp('Co');
    const coRow = (await invite(owner, projectId, { email: co.email, role: 'owner' }).expect(201))
      .body as InviteBody;
    const { invitation, token } = (await invite(co, projectId, { email: newEmail() }).expect(201))
      .body as InviteBody;
    await as(owner, http().patch(`/members/${coRow.member!.id}`))
      .send({ role: 'viewer' })
      .expect(200);
    // The preview says so too (not "valid", then refused on Join).
    await preview(token!).expect(404);
    const taker = await signUp('Taker');
    await accept(taker, token!).expect(404);
    expect((await members(owner, projectId)).some((m) => m.userId === taker.id)).toBe(false);
    // An owner's new link works: they are its inviter now.
    const renewed = (
      await as(owner, http().post(`/invitations/${invitation!.id}/link`)).expect(201)
    ).body as { token: string; invitation: InvitationBody };
    expect(renewed.invitation.invitedById).toBe(owner.id);
    await accept(taker, renewed.token).expect(200);
  });

  it('an invite link makes an editor or a viewer, never an owner', async () => {
    const { owner, projectId } = await setUp();
    const refused = await invite(owner, projectId, { email: newEmail(), role: 'owner' });
    expect(refused.status).toBe(400);
    expect((refused.body as { message: string }).message).toMatch(/editor or a viewer/);
    // Someone with an account can still be added as an owner directly.
    const bob = await signUp('Bob');
    await invite(owner, projectId, { email: bob.email, role: 'owner' }).expect(201);
  });

  it('a member who opens a link does not use it up; an expired one can be invited again', async () => {
    const { owner, projectId } = await setUp();
    const email = newEmail();
    const { token, invitation } = (await invite(owner, projectId, { email }).expect(201))
      .body as InviteBody;
    expect((await accept(owner, token!).expect(200)).body).toEqual({
      projectId,
      alreadyMember: true,
    });
    const nia = await signUp('Nia');
    await accept(nia, token!).expect(200);
    // Expired: inviting the same email again replaces it.
    const later = newEmail();
    const first = (await invite(owner, projectId, { email: later }).expect(201)).body as InviteBody;
    await db.query(
      `UPDATE "invitations" SET "expiresAt" = now() - interval '1 minute' WHERE "id" = $1`,
      [first.invitation!.id],
    );
    const again = (await invite(owner, projectId, { email: later }).expect(201)).body as InviteBody;
    expect(again.invitation!.id).not.toBe(first.invitation!.id);
    expect(invitation!.id).toBeTruthy();
  });

  it('a deleted project takes its invitations (and links) with it', async () => {
    const { owner, projectId } = await setUp();
    const { token } = (await invite(owner, projectId, { email: newEmail() }).expect(201))
      .body as InviteBody;
    await as(owner, http().delete(`/projects/${projectId}`)).expect(200);
    await preview(token!).expect(404);
  });
});
