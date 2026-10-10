import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import type { Repository } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { deleteTestAccounts } from './cleanup.js';
import { Member } from '../src/members/entities/member.entity.js';
import { Project } from '../src/projects/entities/project.entity.js';
import { RealtimeGateway } from '../src/realtime/realtime.gateway.js';
import { clientRoom, projectRoom } from '../src/realtime/realtime.rooms.js';
import { RealtimeService } from '../src/realtime/realtime.service.js';
import type {
  ChangeMessage,
  CursorMessage,
  PresenceMessage,
} from '../src/realtime/realtime.types.js';
import { TaskService } from '../src/tasks/task.service.js';
import { ConfiguredIoAdapter } from '../src/realtime/socket-io.adapter.js';

// The live connection against the real app and database: rooms per project.

describe('Realtime (e2e)', () => {
  let app: INestApplication;
  let url: string;
  let projects: Repository<Project>;
  let gateway: RealtimeGateway;
  let realtime: RealtimeService;
  const sockets: Socket[] = [];
  const made: string[] = [];
  // The projects belong to one account, and the sockets and REST calls are made as it (only a
  // member may join a project's room, only an owner may change a project; see
  // projects/project-access.ts).
  let ownerToken: string;

  /** A socket signed in as `token` (the owner unless told otherwise; null: no token at all). */
  const open = (clientId?: unknown, token: string | null = ownerToken) => {
    const socket = io(url, {
      transports: ['websocket'],
      forceNew: true,
      auth: {
        ...(clientId === undefined ? {} : { clientId }),
        ...(token === null ? {} : { token }),
      },
    });
    sockets.push(socket);
    return socket;
  };
  const connect = async (clientId?: unknown, token?: string | null) => {
    const socket = open(clientId, token);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return socket;
  };
  /** Someone else, signed up for a test: their token and id. */
  const someone = async (name: string) => {
    const body = (
      await request(app.getHttpServer())
        .post('/auth/signup')
        .send({ name, email: `zzrt-${randomUUID()}@example.com`, password: 'pass-word-1' })
        .expect(201)
    ).body as { accessToken: string; user: { id: string; email: string } };
    return { token: body.accessToken, id: body.user.id, email: body.user.email };
  };
  /** A project of the owner's, made the way the app makes one (so they are its owner member). */
  const project = async (name: string) => {
    const saved = (
      await request(app.getHttpServer())
        .post('/projects')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: `zzrt-${name}-${randomUUID()}` })
        .expect(201)
    ).body as { id: string };
    made.push(saved.id);
    return saved.id;
  };
  /** The ids of the sockets in a project's room, as the server sees them. */
  const inRoom = async (projectId: string) =>
    (await gateway.server.in(projectRoom(projectId)).fetchSockets()).map((s) => s.id);
  /** Every change message a socket gets from now on. */
  const inbox = (socket: Socket) => {
    const got: ChangeMessage[] = [];
    socket.on('changed', (message: ChangeMessage) => got.push(message));
    return got;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // As main.ts sets the app up: validation, and the socket adapter.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useWebSocketAdapter(new ConfiguredIoAdapter(app, '*'));
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    projects = app.get(getRepositoryToken(Project));
    gateway = app.get(RealtimeGateway);
    realtime = app.get(RealtimeService);
    const signedUp = (
      await request(app.getHttpServer())
        .post('/auth/signup')
        .send({ name: 'Owner', email: `zzrt-${randomUUID()}@example.com`, password: 'pass-word-1' })
        .expect(201)
    ).body as { accessToken: string; user: { id: string } };
    ownerToken = signedUp.accessToken;
  });

  afterEach(() => {
    sockets.splice(0).forEach((socket) => socket.disconnect());
  });

  afterAll(async () => {
    if (made.length) await projects.delete(made);
    // The accounts go too, with any project of theirs still there.
    await deleteTestAccounts(app, 'zzrt-');
    await app.close();
  });

  it('refuses a socket without a valid token, with the same message as the REST API', async () => {
    const refusal = (socket: Socket) =>
      new Promise<string>((resolve) => socket.once('connect_error', (e) => resolve(e.message)));
    await expect(refusal(open(undefined, null))).resolves.toBe('Sign in first');
    await expect(refusal(open(undefined, 'junk'))).resolves.toBe(
      'Your session has ended. Sign in again',
    );
  });

  it('joins the room of an existing project', async () => {
    const id = await project('a');
    const socket = await connect();
    await expect(socket.emitWithAck('join', { projectId: id })).resolves.toEqual({ ok: true });
    expect(await inRoom(id)).toEqual([socket.id]);
  });

  it('refuses a malformed or unknown project id, and joins nothing', async () => {
    const socket = await connect();
    await expect(socket.emitWithAck('join', { projectId: 'nope' })).resolves.toEqual({
      ok: false,
      error: 'projectId must be a UUID',
    });
    await expect(socket.emitWithAck('join', {})).resolves.toMatchObject({ ok: false });
    await expect(socket.emitWithAck('join', null)).resolves.toMatchObject({ ok: false });
    const unknown = '00000000-0000-4000-8000-000000000000';
    await expect(socket.emitWithAck('join', { projectId: unknown })).resolves.toEqual({
      ok: false,
      error: `Project ${unknown} not found`,
    });
    expect(await inRoom(unknown)).toEqual([]);
  });

  it("someone else's project can't be joined: it looks like one that doesn't exist", async () => {
    const id = await project('x');
    const stranger = await connect(undefined, (await someone('Stranger')).token);
    await expect(stranger.emitWithAck('join', { projectId: id })).resolves.toEqual({
      ok: false,
      error: `Project ${id} not found`,
    });
    expect(await inRoom(id)).toEqual([]);
  });

  it('a join still answers when the database check fails', async () => {
    const socket = await connect();
    const members = app.get<Repository<Member>>(getRepositoryToken(Member));
    const spy = vi.spyOn(members, 'findOne').mockRejectedValueOnce(new Error('db down'));
    await expect(socket.emitWithAck('join', { projectId: randomUUID() })).resolves.toEqual({
      ok: false,
      error: 'Could not check the project. Try again.',
    });
    spy.mockRestore();
  });

  it('is in one project room at a time: joining another leaves the first', async () => {
    const [first, second] = [await project('b1'), await project('b2')];
    const socket = await connect();
    await socket.emitWithAck('join', { projectId: first });
    await socket.emitWithAck('join', { projectId: second });
    expect(await inRoom(first)).toEqual([]);
    expect(await inRoom(second)).toEqual([socket.id]);
  });

  it('a refused join keeps the room it was in', async () => {
    const id = await project('c');
    const socket = await connect();
    await socket.emitWithAck('join', { projectId: id });
    await socket.emitWithAck('join', { projectId: 'nope' });
    expect(await inRoom(id)).toEqual([socket.id]);
  });

  it('leave and disconnect take the socket out of the room', async () => {
    const id = await project('d');
    const [a, b] = [await connect(), await connect()];
    await a.emitWithAck('join', { projectId: id });
    await b.emitWithAck('join', { projectId: id });
    expect((await inRoom(id)).sort()).toEqual([a.id, b.id].sort());
    await expect(a.emitWithAck('leave')).resolves.toEqual({ ok: true });
    expect(await inRoom(id)).toEqual([b.id]);
    b.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await inRoom(id)).toEqual([]);
  });

  describe('change messages', () => {
    it('a tab that sends its client id is in its own room; without one (or junk) it still connects', async () => {
      const id = randomUUID();
      const tab = await connect(id);
      const plain = await connect();
      const junk = await connect('not-a-uuid');
      expect((await gateway.server.in(clientRoom(id)).fetchSockets()).map((s) => s.id)).toEqual([
        tab.id,
      ]);
      expect(plain.connected && junk.connected).toBe(true);
      expect(await gateway.server.in(clientRoom('not-a-uuid')).fetchSockets()).toEqual([]);
    });

    it('reach everyone with the project open except the tab that made the change', async () => {
      const id = await project('m');
      const [senderId, otherId] = [randomUUID(), randomUUID()];
      const sender = await connect(senderId);
      const other = await connect(otherId);
      const plain = await connect();
      for (const socket of [sender, other, plain])
        await socket.emitWithAck('join', { projectId: id });
      const [toSender, toOther, toPlain] = [inbox(sender), inbox(other), inbox(plain)];
      const message: ChangeMessage = {
        projectId: id,
        entity: 'task',
        action: 'update',
        id: randomUUID(),
      };
      realtime.notify(message, senderId);
      await settle();
      expect(toSender).toEqual([]);
      expect(toOther).toEqual([message]);
      expect(toPlain).toEqual([message]);
    });

    it('never reach another project, or a tab that left', async () => {
      const [here, elsewhere] = [await project('n1'), await project('n2')];
      const [a, b, gone] = [await connect(), await connect(), await connect()];
      await a.emitWithAck('join', { projectId: here });
      await b.emitWithAck('join', { projectId: elsewhere });
      await gone.emitWithAck('join', { projectId: here });
      await gone.emitWithAck('leave');
      const [toA, toB, toGone] = [inbox(a), inbox(b), inbox(gone)];
      realtime.notify({ projectId: here, entity: 'event', action: 'create', id: randomUUID() });
      await settle();
      expect(toA).toHaveLength(1);
      expect(toB).toEqual([]);
      expect(toGone).toEqual([]);
    });

    it('a sender id with no tab, or junk, sends to the whole room', async () => {
      const id = await project('o');
      const a = await connect(randomUUID());
      await a.emitWithAck('join', { projectId: id });
      const got = inbox(a);
      realtime.notify({ projectId: id, entity: 'task', action: 'delete' }, randomUUID());
      realtime.notify({ projectId: id, entity: 'task', action: 'delete' }, 'junk');
      await settle();
      expect(got).toHaveLength(2);
    });
  });

  describe('write routes', () => {
    /** A project with two tabs in its room: the one making the changes, and another one. */
    const watched = async (name: string) => {
      const projectId = await project(name);
      const senderId = randomUUID();
      const sender = await connect(senderId);
      const other = await connect(randomUUID());
      await sender.emitWithAck('join', { projectId });
      await other.emitWithAck('join', { projectId });
      return { projectId, senderId, toSender: inbox(sender), toOther: inbox(other) };
    };
    // As the owner of the test projects.
    const http = () =>
      request.agent(app.getHttpServer()).set('Authorization', `Bearer ${ownerToken}`);
    const newTask = (projectId: string, senderId: string, name: string, extra = {}) =>
      http()
        .post('/tasks')
        .set('X-Client-Id', senderId)
        .send({
          projectId,
          name,
          color: '#2a78d6',
          startDate: '2026-11-02',
          endDate: '2026-11-06',
          ...extra,
        })
        .expect(201)
        .then((response) => response.body as { id: string });

    it('every task change reaches the other tab once, never the sender', async () => {
      const { projectId, senderId, toSender, toOther } = await watched('t1');
      const task = await newTask(projectId, senderId, 'Alpha');
      const group = await newTask(projectId, senderId, 'Group', { type: 'group' });
      const as = (call: request.Test) => call.set('X-Client-Id', senderId);
      await as(http().patch(`/tasks/${task.id}`))
        .send({ name: 'Alpha 2' })
        .expect(200);
      await as(http().patch(`/tasks/${task.id}/parent`))
        .send({ parentId: group.id })
        .expect(200);
      await as(http().patch(`/tasks/${task.id}/move`))
        .send({ parentId: null, index: 0 })
        .expect(200);
      await as(http().patch(`/tasks/${task.id}/type`))
        .send({ type: 'milestone' })
        .expect(200);
      await as(http().delete(`/tasks/${task.id}`)).expect(204);
      await settle();
      expect(toSender).toEqual([]);
      expect(toOther.map((m) => [m.entity, m.action, m.id])).toEqual([
        ['task', 'create', task.id],
        ['task', 'create', group.id],
        ['task', 'update', task.id],
        ['task', 'update', task.id],
        ['task', 'update', task.id],
        ['task', 'update', task.id],
        ['task', 'delete', task.id],
      ]);
      expect(toOther.every((m) => m.projectId === projectId)).toBe(true);
    });

    it('an edit that moves groups and linked tasks too is still one message', async () => {
      const { projectId, senderId, toOther } = await watched('t2');
      const group = await newTask(projectId, senderId, 'Group', { type: 'group' });
      const child = await newTask(projectId, senderId, 'Child', { parentId: group.id });
      const next = await newTask(projectId, senderId, 'Next', {
        startDate: '2026-11-09',
        endDate: '2026-11-10',
      });
      await http()
        .post('/dependencies')
        .send({ fromTaskId: child.id, toTaskId: next.id })
        .expect(201);
      await settle();
      toOther.length = 0;
      // Three weeks later: the group stretches and the linked task is pushed, both by the server.
      await http()
        .patch(`/tasks/${child.id}`)
        .set('X-Client-Id', senderId)
        .send({ startDate: '2026-11-23', endDate: '2026-11-27' })
        .expect(200);
      await settle();
      const now = (await http().get(`/tasks?projectId=${projectId}`).expect(200)).body as {
        id: string;
        startDate: string;
        endDate: string;
      }[];
      expect(now.find((t) => t.id === next.id)!.startDate.slice(0, 10) > '2026-11-27').toBe(true);
      expect(now.find((t) => t.id === group.id)!.endDate.slice(0, 10)).toBe('2026-11-27');
      expect(toOther).toEqual([{ projectId, entity: 'task', action: 'update', id: child.id }]);
    });

    it('a refused change (4xx) sends nothing', async () => {
      const { projectId, senderId, toOther } = await watched('t3');
      const task = await newTask(projectId, senderId, 'Alpha');
      await settle();
      toOther.length = 0;
      await http()
        .patch(`/tasks/${task.id}`)
        .send({ startDate: '2026-12-01', endDate: '2026-11-01' })
        .expect(400);
      await http().patch(`/tasks/${randomUUID()}`).send({ name: 'x' }).expect(404);
      await http().patch('/tasks/not-a-uuid').send({ name: 'x' }).expect(400);
      await http().post('/tasks').send({ projectId, name: '' }).expect(400);
      await settle();
      expect(toOther).toEqual([]);
    });

    it('a failure part-way (5xx) tells the others to load again', async () => {
      const { projectId, senderId, toSender, toOther } = await watched('t4');
      const task = await newTask(projectId, senderId, 'Alpha');
      await settle();
      toOther.length = 0;
      const spy = vi.spyOn(app.get(TaskService), 'update').mockRejectedValueOnce(new Error('boom'));
      await http()
        .patch(`/tasks/${task.id}`)
        .set('X-Client-Id', senderId)
        .send({ name: 'x' })
        .expect(500);
      spy.mockRestore();
      await settle();
      expect(toOther).toEqual([{ projectId, entity: 'task', action: 'resync' }]);
      expect(toSender).toEqual([]);
    });

    it('links: create, change and remove reach the other tab once each', async () => {
      const { projectId, senderId, toSender, toOther } = await watched('l1');
      const a = await newTask(projectId, senderId, 'A');
      const b = await newTask(projectId, senderId, 'B', {
        startDate: '2026-11-09',
        endDate: '2026-11-10',
      });
      await settle();
      toOther.length = 0;
      const as = (call: request.Test) => call.set('X-Client-Id', senderId);
      const link = (
        await as(http().post('/dependencies'))
          .send({ fromTaskId: a.id, toTaskId: b.id })
          .expect(201)
      ).body as { id: string };
      await as(http().patch(`/dependencies/${link.id}`))
        .send({ lagDays: 2 })
        .expect(200);
      await as(http().delete(`/dependencies/${link.id}`)).expect(204);
      // Refused: a link from a task to itself.
      await as(http().post('/dependencies')).send({ fromTaskId: a.id, toTaskId: a.id }).expect(400);
      await settle();
      expect(toSender).toEqual([]);
      expect(toOther).toEqual([
        { projectId, entity: 'dependency', action: 'create', id: link.id },
        { projectId, entity: 'dependency', action: 'update', id: link.id },
        { projectId, entity: 'dependency', action: 'delete', id: link.id },
      ]);
    });

    it('events: create, change and remove reach the other tab once each', async () => {
      const { projectId, senderId, toSender, toOther } = await watched('e1');
      const as = (call: request.Test) => call.set('X-Client-Id', senderId);
      const event = (
        await as(http().post('/events'))
          .send({
            projectId,
            name: 'Launch',
            color: '#e5484d',
            startDate: '2026-11-16',
            endDate: '2026-11-18',
          })
          .expect(201)
      ).body as { id: string };
      await as(http().patch(`/events/${event.id}`))
        .send({ name: 'Launch day' })
        .expect(200);
      await as(http().delete(`/events/${event.id}`)).expect(204);
      await settle();
      expect(toSender).toEqual([]);
      expect(toOther).toEqual([
        { projectId, entity: 'event', action: 'create', id: event.id },
        { projectId, entity: 'event', action: 'update', id: event.id },
        { projectId, entity: 'event', action: 'delete', id: event.id },
      ]);
    });

    it('projects: changes go to the project room; a new project tells no one', async () => {
      const { projectId, senderId, toSender, toOther } = await watched('p1');
      const as = (call: request.Test) => call.set('X-Client-Id', senderId);
      const created = (
        await as(http().post('/projects'))
          .send({ name: `zzrt-new-${Date.now()}` })
          .expect(201)
      ).body as { id: string };
      made.push(created.id);
      await as(http().patch(`/projects/${projectId}`))
        .send({ description: 'x' })
        .expect(200);
      await as(http().patch(`/projects/${projectId}/archive`)).expect(200);
      await as(http().patch(`/projects/${projectId}/reopen`)).expect(200);
      await as(http().delete(`/projects/${projectId}`)).expect(200);
      await settle();
      expect(toSender).toEqual([]);
      expect(toOther).toEqual([
        { projectId, entity: 'project', action: 'update', id: projectId },
        { projectId, entity: 'project', action: 'update', id: projectId },
        { projectId, entity: 'project', action: 'update', id: projectId },
        { projectId, entity: 'project', action: 'delete', id: projectId },
      ]);
    });
  });

  describe('members', () => {
    const http = () =>
      request.agent(app.getHttpServer()).set('Authorization', `Bearer ${ownerToken}`);

    it('someone added is told in every tab, even with no project open', async () => {
      const projectId = await project('mb1');
      const bob = await someone('Bob');
      const [tab1, tab2] = [
        await connect(randomUUID(), bob.token),
        await connect(randomUUID(), bob.token),
      ];
      const [got1, got2] = [inbox(tab1), inbox(tab2)];
      const member = (
        await http().post(`/projects/${projectId}/members`).send({ email: bob.email }).expect(201)
      ).body as { id: string };
      await settle();
      const added = { projectId, entity: 'member', action: 'create', id: member.id };
      expect(got1).toEqual([added]);
      expect(got2).toEqual([added]);
      // Now a member: the room opens to them.
      await expect(tab1.emitWithAck('join', { projectId })).resolves.toEqual({ ok: true });
    });

    it('someone removed leaves the room at once and hears nothing more of the project', async () => {
      const projectId = await project('mb2');
      const bob = await someone('Bob');
      const member = (
        await http().post(`/projects/${projectId}/members`).send({ email: bob.email }).expect(201)
      ).body as { id: string };
      const ownerTab = await connect(randomUUID());
      const bobTab = await connect(randomUUID(), bob.token);
      await ownerTab.emitWithAck('join', { projectId });
      await bobTab.emitWithAck('join', { projectId });
      const [toOwner, toBob] = [inbox(ownerTab), inbox(bobTab)];
      await http().delete(`/members/${member.id}`).expect(204);
      await settle();
      const removed = { projectId, entity: 'member', action: 'delete', id: member.id };
      expect(toBob).toEqual([removed]);
      expect(toOwner).toEqual([removed]);
      expect(await inRoom(projectId)).toEqual([ownerTab.id]);
      // A later change in the project doesn't reach them, and they can't join again.
      realtime.notify({ projectId, entity: 'task', action: 'update', id: randomUUID() });
      await settle();
      expect(toBob).toEqual([removed]);
      await expect(bobTab.emitWithAck('join', { projectId })).resolves.toMatchObject({ ok: false });
    });
  });

  describe('cursors', () => {
    /** Every cursor a socket gets from now on. */
    const cursors = (socket: Socket) => {
      const got: CursorMessage[] = [];
      socket.on('cursor', (message: CursorMessage) => got.push(message));
      return got;
    };

    it('reach the others in the room, with who it is; never the sender or another room', async () => {
      const [here, elsewhere] = [await project('c1'), await project('c2')];
      const bob = await someone('Bob');
      await request(app.getHttpServer())
        .post(`/projects/${here}/members`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: bob.email })
        .expect(201);
      const ownerTab = randomUUID();
      const owner = await connect(ownerTab);
      const viewer = await connect(randomUUID(), bob.token);
      const away = await connect(randomUUID());
      await owner.emitWithAck('join', { projectId: here });
      await viewer.emitWithAck('join', { projectId: here });
      await away.emitWithAck('join', { projectId: elsewhere });
      const [toOwner, toBob, toAway] = [cursors(owner), cursors(viewer), cursors(away)];
      owner.emit('cursor', { x: 0.25, y: 0.5 });
      await settle();
      expect(toBob).toEqual([
        {
          projectId: here,
          id: ownerTab,
          userId: expect.any(String),
          name: 'Owner',
          x: 0.25,
          y: 0.5,
        },
      ]);
      expect(toOwner).toEqual([]);
      expect(toAway).toEqual([]);
      // Hidden.
      await new Promise((resolve) => setTimeout(resolve, 40));
      owner.emit('cursor', { x: null, y: null });
      await settle();
      expect(toBob.at(-1)).toMatchObject({ x: null, y: null });
    });

    it('ignores junk, a tab in no room, and more than one every 30 ms', async () => {
      const id = await project('c3');
      const [a, b, roomless] = [await connect(), await connect(), await connect()];
      await a.emitWithAck('join', { projectId: id });
      await b.emitWithAck('join', { projectId: id });
      const toB = cursors(b);
      for (const junk of [
        null,
        'x',
        { x: 2, y: 0.5 },
        { x: -0.1, y: 0 },
        { x: 0.5 },
        { x: null, y: 0.5 },
        { x: '0.5', y: 0.5 },
      ])
        a.emit('cursor', junk);
      roomless.emit('cursor', { x: 0.5, y: 0.5 });
      await settle();
      expect(toB).toEqual([]);
      for (let k = 0; k < 5; k++) a.emit('cursor', { x: 0.1 * k, y: 0.1 });
      await settle();
      expect(toB.length).toBeLessThanOrEqual(2);
      expect(toB[0]).toMatchObject({ x: 0, y: 0.1 });
    });
  });

  describe('presence', () => {
    /** The latest presence message a socket got, from now on. */
    const presence = (socket: Socket) => {
      const seen: { last?: { projectId: string; members: string[] } } = {};
      // Tab ids only (the names are checked on their own).
      socket.on(
        'presence',
        (message: PresenceMessage) =>
          (seen.last = { projectId: message.projectId, members: message.members.map((m) => m.id) }),
      );
      return seen;
    };

    it('everyone in the project hears who has it open, in the order they came', async () => {
      const id = await project('pr1');
      const [aId, bId] = [randomUUID(), randomUUID()];
      const a = await connect(aId);
      const seenA = presence(a);
      await a.emitWithAck('join', { projectId: id });
      await settle();
      expect(seenA.last).toEqual({ projectId: id, members: [aId] });
      const b = await connect(bId);
      const seenB = presence(b);
      await b.emitWithAck('join', { projectId: id });
      await settle();
      expect(seenA.last).toEqual({ projectId: id, members: [aId, bId] });
      expect(seenB.last).toEqual({ projectId: id, members: [aId, bId] });
    });

    it('leaving, switching project and disconnecting update the list', async () => {
      const [here, there] = [await project('pr2'), await project('pr3')];
      const [aId, bId, cId] = [randomUUID(), randomUUID(), randomUUID()];
      const a = await connect(aId);
      const b = await connect(bId);
      const c = await connect(cId);
      const seenA = presence(a);
      for (const s of [a, b, c]) await s.emitWithAck('join', { projectId: here });
      await settle();
      expect(seenA.last?.members).toEqual([aId, bId, cId]);
      await b.emitWithAck('leave');
      await settle();
      expect(seenA.last?.members).toEqual([aId, cId]);
      const seenC = presence(c);
      await c.emitWithAck('join', { projectId: there });
      await settle();
      expect(seenA.last).toEqual({ projectId: here, members: [aId] });
      expect(seenC.last).toEqual({ projectId: there, members: [cId] });
      const d = await connect(randomUUID());
      await d.emitWithAck('join', { projectId: here });
      await settle();
      d.disconnect();
      await settle();
      expect(seenA.last).toEqual({ projectId: here, members: [aId] });
    });

    it('a tab with two connections counts once; a tab without a client id is a guest', async () => {
      const id = await project('pr4');
      const tabId = randomUUID();
      const [first, second] = [await connect(tabId), await connect(tabId)];
      const plain = await connect();
      const seen = presence(first);
      for (const s of [first, second, plain]) await s.emitWithAck('join', { projectId: id });
      await settle();
      expect(seen.last?.members).toEqual([tabId, `guest:${plain.id}`]);
    });

    it('each tab comes with who is signed in there (id and name)', async () => {
      const id = await project('pr6');
      const bob = await someone('Bob');
      await request(app.getHttpServer())
        .post(`/projects/${id}/members`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: bob.email })
        .expect(201);
      const [ownerTab, bobTab] = [randomUUID(), randomUUID()];
      const a = await connect(ownerTab);
      const b = await connect(bobTab, bob.token);
      let last: PresenceMessage | undefined;
      a.on('presence', (message: PresenceMessage) => (last = message));
      await a.emitWithAck('join', { projectId: id });
      await b.emitWithAck('join', { projectId: id });
      await settle();
      expect(last?.members).toEqual([
        { id: ownerTab, userId: expect.any(String), name: 'Owner' },
        { id: bobTab, userId: bob.id, name: 'Bob' },
      ]);
    });

    it('a refused join announces nothing', async () => {
      const id = await project('pr5');
      const a = await connect(randomUUID());
      await a.emitWithAck('join', { projectId: id });
      await settle();
      const seen = presence(a);
      await a.emitWithAck('join', { projectId: 'nope' });
      await settle();
      expect(seen.last).toBeUndefined();
    });
  });
});
