import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { createValidationPipe } from '../src/common/validation.js';
import { JOIN_LIMIT, JOIN_TOO_OFTEN } from '../src/realtime/realtime.gateway.js';
import { ConfiguredIoAdapter } from '../src/realtime/socket-io.adapter.js';
import { deleteTestAccounts } from './cleanup.js';

// The live connection with the rate limits switched on (the other e2e tests run without them), as
// in production. The HTTP limits must not touch socket messages: a `leave` without a payload
// crashed the limiter, and every socket of every user was counted against one shared limit.

describe('Realtime with rate limits on (e2e)', () => {
  let app: INestApplication | undefined;
  let url: string;
  const sockets: Socket[] = [];
  const saved = { NODE_ENV: process.env.NODE_ENV, JWT_SECRET: process.env.JWT_SECRET };

  beforeAll(async () => {
    // Before AppModule is loaded: its config is read and checked when it is imported.
    process.env.NODE_ENV = 'development';
    // Outside tests the app requires a real secret: a throwaway one (nothing outside this test).
    process.env.JWT_SECRET ??= randomBytes(48).toString('base64');
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nest = moduleRef.createNestApplication();
    nest.useGlobalPipes(createValidationPipe());
    nest.useWebSocketAdapter(new ConfiguredIoAdapter(nest, '*'));
    await nest.listen(0);
    url = `http://127.0.0.1:${(nest.getHttpServer().address() as AddressInfo).port}`;
    app = nest;
  });

  afterEach(() => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
  });

  afterAll(async () => {
    if (app) {
      await deleteTestAccounts(app, 'zzwsthr-');
      await app.close();
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** Someone with a project of their own: a socket signed in as them, and the project id. */
  const someoneWithProject = async (name: string) => {
    const http = () => request(app!.getHttpServer());
    const { accessToken } = (
      await http()
        .post('/auth/signup')
        .send({ name, email: `zzwsthr-${randomUUID()}@example.com`, password: 'pass-word-1' })
        .expect(201)
    ).body as { accessToken: string };
    const { id } = (
      await http()
        .post('/projects')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: `WS ${randomUUID()}` })
        .expect(201)
    ).body as { id: string };
    const socket = io(url, {
      transports: ['websocket'],
      forceNew: true,
      auth: { token: accessToken },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    // A crash in a guard comes back as an `exception` event, not as an answer.
    const exceptions: unknown[] = [];
    socket.on('exception', (error: unknown) => exceptions.push(error));
    return { socket, projectId: id, exceptions };
  };
  const ack = (socket: Socket, event: string, ...args: unknown[]) =>
    socket.timeout(3000).emitWithAck(event, ...args) as Promise<unknown>;

  it('answers a leave sent without a payload (as the app sends it)', async () => {
    const ada = await someoneWithProject('Ada');
    await expect(ack(ada.socket, 'join', { projectId: ada.projectId })).resolves.toEqual({
      ok: true,
    });
    await expect(ack(ada.socket, 'leave')).resolves.toEqual({ ok: true });
    expect(ada.exceptions).toEqual([]);
  });

  it("one person's many cursor moves don't use up anyone's limit", async () => {
    const ada = await someoneWithProject('Ada');
    await expect(ack(ada.socket, 'join', { projectId: ada.projectId })).resolves.toEqual({
      ok: true,
    });
    // More than the HTTP limit of 600 a minute, as a few minutes of moving the mouse would send.
    for (let i = 0; i < 700; i++) ada.socket.emit('cursor', { x: (i % 100) / 100, y: 0.5 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ada.exceptions).toEqual([]);
    // Someone else, on another socket, still joins their project.
    const bob = await someoneWithProject('Bob');
    await expect(ack(bob.socket, 'join', { projectId: bob.projectId })).resolves.toEqual({
      ok: true,
    });
    expect(bob.exceptions).toEqual([]);
  });

  it('limits joins per socket, without touching anyone else', async () => {
    const ada = await someoneWithProject('Ada');
    for (let i = 0; i < JOIN_LIMIT; i++) {
      await expect(ack(ada.socket, 'join', { projectId: ada.projectId })).resolves.toEqual({
        ok: true,
      });
    }
    // One more within the window: refused, with a reason the app retries on.
    await expect(ack(ada.socket, 'join', { projectId: ada.projectId })).resolves.toEqual({
      ok: false,
      error: JOIN_TOO_OFTEN,
    });
    // Malformed joins count too: a flood of them can't get past the limit either.
    await expect(ack(ada.socket, 'join', { projectId: 'nope' })).resolves.toEqual({
      ok: false,
      error: JOIN_TOO_OFTEN,
    });
    // Still in the room from before: refusing a join doesn't throw anyone out.
    expect(ada.exceptions).toEqual([]);
    // Another socket (someone else, or another tab) has its own count.
    const bob = await someoneWithProject('Bob');
    await expect(ack(bob.socket, 'join', { projectId: bob.projectId })).resolves.toEqual({
      ok: true,
    });
  });

  it('still limits HTTP requests', async () => {
    // The sign-in limit (10 a minute per address) keeps working.
    const signIn = () =>
      request(app!.getHttpServer())
        .post('/auth/signin')
        .send({ email: `zzwsthr-none-${randomUUID()}@example.com`, password: 'wrong-pass-1' });
    for (let i = 0; i < 10; i++) expect((await signIn()).status).toBe(401);
    expect((await signIn()).status).toBe(429);
  });
});
