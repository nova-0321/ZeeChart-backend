import { type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/validation.js';
import { ConfiguredIoAdapter } from '../src/realtime/socket-io.adapter.js';
import { deleteTestAccounts } from './cleanup.js';

// Signing out everywhere (#49): every token made so far stops working at once, on the API and on
// the live connection, and the account's open sockets close. Other accounts are not touched.

const ENDED = 'Your session has ended. Sign in again';

describe('Signing out everywhere (e2e)', () => {
  let app: INestApplication;
  let url: string;
  const sockets: Socket[] = [];
  const http = () => request(app.getHttpServer());

  interface Account {
    id: string;
    email: string;
    token: string;
  }
  const signUp = async (name: string): Promise<Account> => {
    const email = `zzsess-${name.toLowerCase()}-${randomUUID()}@example.com`;
    const body = (
      await http().post('/auth/signup').send({ name, email, password: 'pass-word-1' }).expect(201)
    ).body as { accessToken: string; user: { id: string } };
    return { id: body.user.id, email, token: body.accessToken };
  };
  const signIn = async (who: Account) =>
    (
      (
        await http()
          .post('/auth/signin')
          .send({ email: who.email, password: 'pass-word-1' })
          .expect(200)
      ).body as { accessToken: string }
    ).accessToken;
  const me = (token: string) => http().get('/auth/me').set('Authorization', `Bearer ${token}`);
  const projects = (token: string) =>
    http().get('/projects').set('Authorization', `Bearer ${token}`);
  const signOutEverywhere = (token: string) =>
    http().post('/auth/signout-all').set('Authorization', `Bearer ${token}`);
  const messageOf = (response: request.Response) => (response.body as { message: string }).message;

  const open = (token: string) => {
    const socket = io(url, { transports: ['websocket'], forceNew: true, auth: { token } });
    sockets.push(socket);
    return socket;
  };
  const connected = (socket: Socket) =>
    new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
  const refused = (socket: Socket) =>
    new Promise<string>((resolve) => socket.once('connect_error', (e) => resolve(e.message)));
  const closed = (socket: Socket) =>
    new Promise<string>((resolve) => socket.once('disconnect', (reason) => resolve(reason)));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    app.useWebSocketAdapter(new ConfiguredIoAdapter(app, '*'));
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterEach(() => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzsess-');
    await app.close();
  });

  it("ends every token of the account at once, the one that asked too, and nobody else's", async () => {
    const ada = await signUp('Ada');
    const bob = await signUp('Bob');
    const adaSecond = await signIn(ada); // a second device
    for (const token of [ada.token, adaSecond, bob.token]) await me(token).expect(200);

    await signOutEverywhere(ada.token).expect(204);

    for (const token of [ada.token, adaSecond]) {
      const response = await me(token).expect(401);
      expect(messageOf(response)).toBe(ENDED);
      await projects(token).expect(401);
    }
    // Bob is not touched.
    await me(bob.token).expect(200);
    await projects(bob.token).expect(200);

    // Signing in again works, and the new token is good until the next time.
    const adaAgain = await signIn(ada);
    await me(adaAgain).expect(200);
    await signOutEverywhere(adaAgain).expect(204);
    await me(adaAgain).expect(401);
  });

  it('needs a signed-in user', async () => {
    await http().post('/auth/signout-all').expect(401);
    await signOutEverywhere('junk').expect(401);
  });

  it('says the same for an ended token as for an expired one: nothing about the account', async () => {
    const ada = await signUp('Ada');
    await signOutEverywhere(ada.token).expect(204);
    const ended = await me(ada.token).expect(401);
    const jwt = app.get(JwtService, { strict: false });
    const expired = await me(await jwt.signAsync({ sub: ada.id }, { expiresIn: -10 })).expect(401);
    expect(messageOf(ended)).toBe(messageOf(expired));
  });

  it('a token made before the number existed works until the first sign-out, then stops', async () => {
    const jwt = app.get(JwtService, { strict: false });
    const ada = await signUp('Ada');
    // How an earlier version made them: just the user's id.
    const legacy = await jwt.signAsync({ sub: ada.id });
    await me(legacy).expect(200);
    await signOutEverywhere(ada.token).expect(204);
    await me(legacy).expect(401);
  });

  it('refuses a token claiming a number the account has not reached', async () => {
    const jwt = app.get(JwtService, { strict: false });
    const ada = await signUp('Ada');
    await me(await jwt.signAsync({ sub: ada.id, tv: 0 })).expect(200);
    await me(await jwt.signAsync({ sub: ada.id, tv: 5 })).expect(401);
    await me(await jwt.signAsync({ sub: ada.id, tv: -1 })).expect(401);
  });

  it('closes the open live connections of the account, refuses old tokens there, takes new ones', async () => {
    const ada = await signUp('Ada');
    const bob = await signUp('Bob');
    const [adaTab1, adaTab2, bobTab] = [open(ada.token), open(ada.token), open(bob.token)];
    await Promise.all([adaTab1, adaTab2, bobTab].map(connected));

    const gone = Promise.all([closed(adaTab1), closed(adaTab2)]);
    await signOutEverywhere(ada.token).expect(204);
    // Both of her tabs are closed by the server (not left until the token runs out).
    expect(await gone).toEqual(['io server disconnect', 'io server disconnect']);
    // Bob's stays.
    expect(bobTab.connected).toBe(true);

    // The old token can't open a new one; a token from a new sign-in can.
    await expect(refused(open(ada.token))).resolves.toBe(ENDED);
    const fresh = open(await signIn(ada));
    await connected(fresh);
    expect(fresh.connected).toBe(true);
  });
});
