import type { Socket } from 'socket.io';
import { SessionEvents } from '../auth/token.js';
import { roleIn } from '../members/membership.js';
import { JOIN_LIMIT, JOIN_TOO_OFTEN, JOIN_WINDOW_MS, RealtimeGateway } from './realtime.gateway.js';

// The database is only asked through roleIn: each test says what it answers.
vi.mock('../members/membership.js', () => ({ roleIn: vi.fn() }));
const role = vi.mocked(roleIn);

const P1 = '3f2b8c1e-9a4d-4e5f-8a6b-7c8d9e0f1a2b';
const P2 = '7a1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
const TAB = '0d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a';
const OTHER_TAB = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';

type FakeSocket = ReturnType<typeof fakeSocket>;

/** Enough of a socket.io socket: its rooms (a Set, as socket.io keeps them) and what it sent. */
const fakeSocket = (id: string, auth: Record<string, unknown> = {}) => {
  const rooms = new Set<string>([id]);
  const volatileEmit = vi.fn();
  return {
    id,
    data: {} as Record<string, unknown>,
    handshake: { auth },
    rooms,
    join: vi.fn((room: string | string[]) => {
      for (const r of Array.isArray(room) ? room : [room]) rooms.add(r);
      return Promise.resolve();
    }),
    leave: vi.fn((room: string) => {
      rooms.delete(room);
      return Promise.resolve();
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    volatile: { to: vi.fn(() => ({ emit: volatileEmit })) },
    volatileEmit,
  };
};

/** A server over the given sockets: fetchSockets answers them in the order they were added. */
const fakeServer = (sockets: FakeSocket[]) => {
  const sent: { room: string; event: string; message: unknown }[] = [];
  const disconnectSockets = vi.fn();
  const socketsLeave = vi.fn();
  let middleware: ((socket: unknown, next: (error?: Error) => void) => void) | undefined;
  const server = {
    use: vi.fn((fn: typeof middleware) => {
      middleware = fn;
    }),
    in: vi.fn((room: string) => ({
      fetchSockets: () =>
        Promise.resolve(sockets.filter((s) => s.rooms.has(room)).map((s) => ({ data: s.data }))),
      disconnectSockets,
      socketsLeave,
    })),
    to: vi.fn((room: string) => ({
      emit: (event: string, message: unknown) => sent.push({ room, event, message }),
    })),
  };
  /** Runs the connection check; answers the error it refused with, or undefined. */
  const connect = (socket: FakeSocket) =>
    new Promise<Error | undefined>((resolve) => middleware!(socket, resolve));
  return { server, sent, disconnectSockets, socketsLeave, connect };
};

const setup = (sockets: FakeSocket[] = []) => {
  const jwt = { verifyAsync: vi.fn() };
  const auth = { sessionOf: vi.fn() };
  const sessions = new SessionEvents();
  const db = {};
  const gateway = new RealtimeGateway(jwt as never, db as never, sessions, auth as never);
  const fake = fakeServer(sockets);
  gateway.server = fake.server as never;
  gateway.afterInit(fake.server as never);
  vi.spyOn(gateway['logger'], 'error').mockImplementation(() => undefined);
  vi.spyOn(gateway['logger'], 'debug').mockImplementation(() => undefined);
  return { gateway, jwt, auth, sessions, db, ...fake };
};

/** A socket that passed the connection check as `userId` (named `name`). */
const signedIn = (id: string, userId: string, name: string, clientId?: string) => {
  const socket = fakeSocket(id, clientId ? { clientId } : {});
  Object.assign(socket.data, { userId, name });
  return socket;
};

const asSocket = (socket: FakeSocket) => socket as unknown as Socket;

beforeEach(() => {
  vi.clearAllMocks();
  role.mockResolvedValue('editor');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeGateway connection check', () => {
  it('refuses a socket without a token', async () => {
    const { connect, jwt } = setup();
    for (const auth of [{}, { token: '' }, { token: 42 }]) {
      const error = await connect(fakeSocket('s1', auth));
      expect(error?.message).toBe('Sign in first');
    }
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('refuses a bad token (expired, tampered with) as an ended session', async () => {
    const { connect, jwt, auth } = setup();
    jwt.verifyAsync.mockRejectedValue(new Error('invalid signature'));
    const error = await connect(fakeSocket('s1', { token: 'junk' }));
    expect(error?.message).toBe('Your session has ended. Sign in again');
    expect(auth.sessionOf).not.toHaveBeenCalled();
  });

  it('refuses a deleted account and a token from before "sign out everywhere"', async () => {
    const { connect, jwt, auth } = setup();
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', tv: 1 });
    auth.sessionOf.mockResolvedValueOnce(null);
    expect((await connect(fakeSocket('s1', { token: 't' })))?.message).toBe(
      'Your session has ended. Sign in again',
    );
    auth.sessionOf.mockResolvedValueOnce({ name: 'Ada', tokenVersion: 2 });
    const socket = fakeSocket('s2', { token: 't' });
    expect((await connect(socket))?.message).toBe('Your session has ended. Sign in again');
    expect(socket.data.userId).toBeUndefined();
  });

  it('a good token lets it in, keeping who it is and when the token runs out', async () => {
    const { connect, jwt, auth } = setup();
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1', tv: 3, exp: 2_000_000_000 });
    auth.sessionOf.mockResolvedValue({ name: 'Ada', tokenVersion: 3 });
    const socket = fakeSocket('s1', { token: 'good' });
    expect(await connect(socket)).toBeUndefined();
    expect(jwt.verifyAsync).toHaveBeenCalledWith('good');
    expect(auth.sessionOf).toHaveBeenCalledWith('u1');
    expect(socket.data).toEqual({ userId: 'u1', name: 'Ada', expiresAt: 2_000_000_000_000 });
  });

  it('a token without a version counts as version 0, and one without exp never expires', async () => {
    const { connect, jwt, auth } = setup();
    jwt.verifyAsync.mockResolvedValue({ sub: 'u1' });
    auth.sessionOf.mockResolvedValue({ name: 'Ada', tokenVersion: 0 });
    const socket = fakeSocket('s1', { token: 'old' });
    expect(await connect(socket)).toBeUndefined();
    expect(socket.data.expiresAt).toBeUndefined();
  });
});

describe('RealtimeGateway handleConnection', () => {
  it('puts a tab with a client id in its user room and its own tab room', async () => {
    const { gateway } = setup();
    const socket = signedIn('s1', 'u1', 'Ada', TAB.toUpperCase());
    await gateway.handleConnection(asSocket(socket));
    expect(socket.join).toHaveBeenCalledWith(['user:u1', `client:u1:${TAB}`]);
    // Under the user: someone else's copied tab id can't make two people one entry.
    expect(socket.data.memberId).toBe(`u1:${TAB}`);
  });

  it('a tab without a client id (or with junk) still connects, as a guest', async () => {
    const { gateway } = setup();
    for (const clientId of [undefined, 'junk']) {
      const socket = signedIn('s1', 'u1', 'Ada', clientId);
      await gateway.handleConnection(asSocket(socket));
      expect(socket.join).toHaveBeenCalledWith(['user:u1']);
      expect(socket.data.memberId).toBe('guest:s1');
    }
  });

  it('closes a connection whose token already ran out', async () => {
    const { gateway } = setup();
    const socket = signedIn('s1', 'u1', 'Ada');
    socket.data.expiresAt = Date.now() - 1;
    await gateway.handleConnection(asSocket(socket));
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('closes the connection when the token runs out, and not before', async () => {
    vi.useFakeTimers();
    const { gateway } = setup();
    const socket = signedIn('s1', 'u1', 'Ada');
    socket.data.expiresAt = Date.now() + 60_000;
    await gateway.handleConnection(asSocket(socket));
    vi.advanceTimersByTime(59_999);
    expect(socket.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('a token running out after the longest timer wait is checked again then', async () => {
    vi.useFakeTimers();
    const { gateway } = setup();
    const socket = signedIn('s1', 'u1', 'Ada');
    const MAX = 2 ** 31 - 1;
    socket.data.expiresAt = Date.now() + MAX + 1000;
    await gateway.handleConnection(asSocket(socket));
    vi.advanceTimersByTime(MAX);
    expect(socket.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('a disconnect stops the expiry timer', async () => {
    vi.useFakeTimers();
    const { gateway } = setup();
    const socket = signedIn('s1', 'u1', 'Ada');
    socket.data.expiresAt = Date.now() + 60_000;
    await gateway.handleConnection(asSocket(socket));
    await gateway.handleDisconnect(asSocket(socket));
    vi.advanceTimersByTime(120_000);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});

describe('RealtimeGateway join', () => {
  const connected = async (gateway: RealtimeGateway, socket: FakeSocket): Promise<FakeSocket> => {
    await gateway.handleConnection(asSocket(socket));
    return socket;
  };

  it('refuses a missing, null or malformed project id, and asks the database nothing', async () => {
    const socket = signedIn('s1', 'u1', 'Ada');
    const { gateway, sent } = setup([socket]);
    for (const body of [undefined, null, {}, { projectId: 42 }, { projectId: 'abc' }]) {
      expect(await gateway.join(asSocket(socket), body)).toEqual({
        ok: false,
        error: 'projectId must be a UUID',
      });
    }
    expect(role).not.toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("an unknown project and someone else's get the same answer, and no room", async () => {
    const socket = signedIn('s1', 'u1', 'Ada');
    const { gateway, db, sent } = setup([socket]);
    // roleIn answers null for both: not a member is all the gateway can know.
    role.mockResolvedValue(null);
    const answers = [
      await gateway.join(asSocket(socket), { projectId: P1 }),
      await gateway.join(asSocket(socket), { projectId: P2 }),
    ];
    expect(answers).toEqual([
      { ok: false, error: 'Project not found' },
      { ok: false, error: 'Project not found' },
    ]);
    expect(role).toHaveBeenCalledWith(db, P1, 'u1');
    expect(socket.rooms.has(`project:${P1}`)).toBe(false);
    expect(sent).toEqual([]);
  });

  it('a refused join keeps the room it was in', async () => {
    const socket = signedIn('s1', 'u1', 'Ada');
    const { gateway } = setup([socket]);
    await connected(gateway, socket);
    await gateway.join(asSocket(socket), { projectId: P1 });
    role.mockResolvedValue(null);
    await gateway.join(asSocket(socket), { projectId: P2 });
    expect(socket.rooms.has(`project:${P1}`)).toBe(true);
    expect(socket.data.projectId).toBe(P1);
  });

  it('a member joins the room and everyone there hears who has it open', async () => {
    const socket = signedIn('s1', 'u1', 'Ada', TAB);
    const { gateway, sent } = setup([socket]);
    await connected(gateway, socket);
    expect(await gateway.join(asSocket(socket), { projectId: P1 })).toEqual({ ok: true });
    expect(socket.rooms.has(`project:${P1}`)).toBe(true);
    expect(socket.data.projectId).toBe(P1);
    expect(sent).toEqual([
      {
        room: `project:${P1}`,
        event: 'presence',
        message: { projectId: P1, members: [{ id: `u1:${TAB}`, userId: 'u1', name: 'Ada' }] },
      },
    ]);
  });

  it('joining another project leaves the first, and both rooms hear of it', async () => {
    const socket = signedIn('s1', 'u1', 'Ada', TAB);
    const { gateway, sent } = setup([socket]);
    await connected(gateway, socket);
    await gateway.join(asSocket(socket), { projectId: P1 });
    sent.length = 0;
    expect(await gateway.join(asSocket(socket), { projectId: P2 })).toEqual({ ok: true });
    expect(socket.leave).toHaveBeenCalledWith(`project:${P1}`);
    expect([...socket.rooms].filter((r) => r.startsWith('project:'))).toEqual([`project:${P2}`]);
    expect(sent).toEqual([
      {
        room: `project:${P2}`,
        event: 'presence',
        message: { projectId: P2, members: [{ id: `u1:${TAB}`, userId: 'u1', name: 'Ada' }] },
      },
      { room: `project:${P1}`, event: 'presence', message: { projectId: P1, members: [] } },
    ]);
  });

  it('joining the room it is already in leaves nothing', async () => {
    const socket = signedIn('s1', 'u1', 'Ada');
    const { gateway, sent } = setup([socket]);
    await connected(gateway, socket);
    await gateway.join(asSocket(socket), { projectId: P1 });
    sent.length = 0;
    expect(await gateway.join(asSocket(socket), { projectId: P1 })).toEqual({ ok: true });
    expect(socket.leave).not.toHaveBeenCalled();
    expect(sent.map((s) => s.room)).toEqual([`project:${P1}`]);
  });

  it('removed while joining: out of the room again, and the room it left is told', async () => {
    const socket = signedIn('s1', 'u1', 'Ada');
    const { gateway, sent } = setup([socket]);
    await connected(gateway, socket);
    await gateway.join(asSocket(socket), { projectId: P1 });
    sent.length = 0;
    // A member at the first check, gone at the re-check after joining the room.
    role.mockResolvedValueOnce('editor').mockResolvedValueOnce(null);
    expect(await gateway.join(asSocket(socket), { projectId: P2 })).toEqual({
      ok: false,
      error: 'Project not found',
    });
    expect(socket.leave).toHaveBeenCalledWith(`project:${P2}`);
    expect(socket.rooms.has(`project:${P2}`)).toBe(false);
    expect(socket.data.projectId).toBe(P1);
    // Nothing is said in the project it never really joined.
    expect(sent).toEqual([
      { room: `project:${P1}`, event: 'presence', message: { projectId: P1, members: [] } },
    ]);
  });

  it('a failing re-check counts as removed', async () => {
    const socket = signedIn('s1', 'u1', 'Ada');
    const { gateway } = setup([socket]);
    role.mockResolvedValueOnce('viewer').mockRejectedValueOnce(new Error('connection lost'));
    expect(await gateway.join(asSocket(socket), { projectId: P1 })).toEqual({
      ok: false,
      error: 'Project not found',
    });
    expect(socket.rooms.has(`project:${P1}`)).toBe(false);
  });

  it('a failing check still answers (the client waits for it), and joins nothing', async () => {
    const socket = signedIn('s1', 'u1', 'Ada');
    const { gateway, sent } = setup([socket]);
    role.mockRejectedValue(new Error('connection lost'));
    expect(await gateway.join(asSocket(socket), { projectId: P1 })).toEqual({
      ok: false,
      error: 'Could not check the project. Try again.',
    });
    expect(gateway['logger'].error).toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it(`refuses more than ${JOIN_LIMIT} joins in ${JOIN_WINDOW_MS} ms, refused ones too, without a query`, async () => {
    vi.useFakeTimers();
    const socket = signedIn('s1', 'u1', 'Ada');
    const { gateway } = setup([socket]);
    for (let k = 0; k < JOIN_LIMIT; k++) await gateway.join(asSocket(socket), { projectId: 'bad' });
    expect(await gateway.join(asSocket(socket), { projectId: P1 })).toEqual({
      ok: false,
      error: JOIN_TOO_OFTEN,
    });
    expect(role).not.toHaveBeenCalled();
    // Once the window has passed, it may join again.
    vi.advanceTimersByTime(JOIN_WINDOW_MS);
    expect(await gateway.join(asSocket(socket), { projectId: P1 })).toEqual({ ok: true });
  });
});

describe('RealtimeGateway leave and disconnect', () => {
  const twoTabs = async () => {
    const a = signedIn('s1', 'u1', 'Ada', TAB);
    const b = signedIn('s2', 'u1', 'Ada', OTHER_TAB);
    const ctx = setup([a, b]);
    for (const s of [a, b]) {
      await ctx.gateway.handleConnection(asSocket(s));
      await ctx.gateway.join(asSocket(s), { projectId: P1 });
    }
    ctx.sent.length = 0;
    return { a, b, ...ctx };
  };

  it('leave takes the tab out and tells the room; the same user’s other tab stays', async () => {
    const { a, b, gateway, sent } = await twoTabs();
    expect(await gateway.leave(asSocket(a))).toEqual({ ok: true });
    expect(a.rooms.has(`project:${P1}`)).toBe(false);
    expect(a.data.projectId).toBeUndefined();
    // Its own rooms (user, tab) are kept: it still hears of its memberships.
    expect(a.rooms.has('user:u1')).toBe(true);
    expect(b.rooms.has(`project:${P1}`)).toBe(true);
    expect(sent).toEqual([
      {
        room: `project:${P1}`,
        event: 'presence',
        message: { projectId: P1, members: [{ id: `u1:${OTHER_TAB}`, userId: 'u1', name: 'Ada' }] },
      },
    ]);
  });

  it('leave outside any room answers ok and announces nothing', async () => {
    const socket = signedIn('s1', 'u1', 'Ada');
    const { gateway, sent } = setup([socket]);
    expect(await gateway.leave(asSocket(socket))).toEqual({ ok: true });
    expect(sent).toEqual([]);
  });

  it('a disconnect tells the room it was in; the other tab stays listed', async () => {
    const { a, b, gateway, sent } = await twoTabs();
    // socket.io empties the rooms before handleDisconnect: the project is known from its data.
    a.rooms.clear();
    await gateway.handleDisconnect(asSocket(a));
    expect(b.rooms.has(`project:${P1}`)).toBe(true);
    expect(sent).toEqual([
      {
        room: `project:${P1}`,
        event: 'presence',
        message: { projectId: P1, members: [{ id: `u1:${OTHER_TAB}`, userId: 'u1', name: 'Ada' }] },
      },
    ]);
  });

  it('a disconnect outside any project announces nothing', async () => {
    const socket = signedIn('s1', 'u1', 'Ada');
    const { gateway, sent } = setup([socket]);
    await gateway.handleDisconnect(asSocket(socket));
    expect(sent).toEqual([]);
  });
});

describe('RealtimeGateway membersOf', () => {
  it('one entry per tab, in the order they came, each with who is signed in there', async () => {
    const ada = signedIn('s1', 'u1', 'Ada', TAB);
    const bob = signedIn('s2', 'u2', 'Bob');
    // The same tab connected twice (a reconnect overlapping): counted once.
    const adaAgain = signedIn('s3', 'u1', 'Ada', TAB);
    const adaOtherTab = signedIn('s4', 'u1', 'Ada', OTHER_TAB);
    const elsewhere = signedIn('s5', 'u3', 'Cy');
    const sockets = [ada, bob, adaAgain, adaOtherTab, elsewhere];
    const { gateway, server } = setup(sockets);
    for (const s of sockets) await gateway.handleConnection(asSocket(s));
    for (const s of [ada, bob, adaAgain, adaOtherTab]) s.rooms.add(`project:${P1}`);
    elsewhere.rooms.add(`project:${P2}`);
    expect(await gateway.membersOf(P1)).toEqual([
      { id: `u1:${TAB}`, userId: 'u1', name: 'Ada' },
      { id: 'guest:s2', userId: 'u2', name: 'Bob' },
      { id: `u1:${OTHER_TAB}`, userId: 'u1', name: 'Ada' },
    ]);
    expect(server.in).toHaveBeenCalledWith(`project:${P1}`);
  });

  it('an empty room has no one', async () => {
    const { gateway } = setup([]);
    expect(await gateway.membersOf(P1)).toEqual([]);
  });
});

describe('RealtimeGateway removeUser', () => {
  it("takes every tab of the user out of the project's room and tells who is left", async () => {
    const bob = signedIn('s2', 'u2', 'Bob');
    const { gateway, server, socketsLeave, sent } = setup([bob]);
    await gateway.handleConnection(asSocket(bob));
    bob.rooms.add(`project:${P1}`);
    await gateway.removeUser('u1', P1);
    expect(server.in).toHaveBeenCalledWith('user:u1');
    expect(socketsLeave).toHaveBeenCalledWith(`project:${P1}`);
    expect(sent).toEqual([
      {
        room: `project:${P1}`,
        event: 'presence',
        message: { projectId: P1, members: [{ id: 'guest:s2', userId: 'u2', name: 'Bob' }] },
      },
    ]);
  });
});

describe('RealtimeGateway sign out everywhere', () => {
  it("closes that user's open connections, and only theirs", () => {
    const { sessions, server, disconnectSockets } = setup();
    sessions.revoked('u1');
    expect(server.in).toHaveBeenCalledWith('user:u1');
    expect(server.in).toHaveBeenCalledTimes(1);
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it('another listener failing does not keep the connections open', () => {
    const { sessions, disconnectSockets } = setup();
    vi.spyOn(sessions['logger'], 'error').mockImplementation(() => undefined);
    sessions.onRevoked(() => {
      throw new Error('boom');
    });
    expect(() => sessions.revoked('u1')).not.toThrow();
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });
});

describe('RealtimeGateway cursor', () => {
  const inRoom = async () => {
    const socket = signedIn('s1', 'u1', 'Ada', TAB);
    const ctx = setup([socket]);
    await ctx.gateway.handleConnection(asSocket(socket));
    await ctx.gateway.join(asSocket(socket), { projectId: P1 });
    return { socket, ...ctx };
  };
  const who = { projectId: P1, id: `u1:${TAB}`, userId: 'u1', name: 'Ada' };

  it('passes it to the others in its room, with who it is', async () => {
    const { socket, gateway } = await inRoom();
    gateway.cursor(asSocket(socket), { x: 0.25, y: 0.5, extra: 'dropped' });
    expect(socket.volatile.to).toHaveBeenCalledWith(`project:${P1}`);
    expect(socket.volatileEmit).toHaveBeenCalledWith('cursor', { ...who, x: 0.25, y: 0.5 });
  });

  it('sends nothing from a tab in no room, or one taken out of its room', async () => {
    const roomless = signedIn('s9', 'u1', 'Ada');
    const { gateway } = setup([roomless]);
    gateway.cursor(asSocket(roomless), { x: 0.5, y: 0.5 });
    expect(roomless.volatile.to).not.toHaveBeenCalled();
    const { socket, gateway: g } = await inRoom();
    // Removed from the project: out of the room, though its data still names it.
    socket.rooms.delete(`project:${P1}`);
    g.cursor(asSocket(socket), { x: 0.5, y: 0.5 });
    expect(socket.volatile.to).not.toHaveBeenCalled();
  });

  it('ignores junk', async () => {
    const { socket, gateway } = await inRoom();
    for (const junk of [
      undefined,
      null,
      {},
      { x: 0.5 },
      { x: 2, y: 0.5 },
      { x: -0.1, y: 0.5 },
      { x: '0.5', y: 0.5 },
      { x: Number.NaN, y: 0.5 },
      { x: null, y: 0.5 },
    ]) {
      gateway.cursor(asSocket(socket), junk);
    }
    expect(socket.volatileEmit).not.toHaveBeenCalled();
  });

  it('passes on at most one every 30 ms, but a hide always goes through', async () => {
    vi.useFakeTimers();
    const { socket, gateway } = await inRoom();
    gateway.cursor(asSocket(socket), { x: 0.1, y: 0.1 });
    gateway.cursor(asSocket(socket), { x: 0.2, y: 0.1 });
    expect(socket.volatileEmit).toHaveBeenCalledTimes(1);
    gateway.cursor(asSocket(socket), { x: null, y: null });
    expect(socket.volatileEmit).toHaveBeenLastCalledWith('cursor', { ...who, x: null, y: null });
    vi.advanceTimersByTime(30);
    gateway.cursor(asSocket(socket), { x: 0.3, y: 0.1 });
    expect(socket.volatileEmit).toHaveBeenCalledTimes(3);
  });

  it('carries what the pointer is over, rebuilt field by field', async () => {
    vi.useFakeTimers();
    const { socket, gateway } = await inRoom();
    const anchors = [
      { k: 't', day: '2026-10-16', dx: 0.5, row: 'task-1', ry: 0.25 },
      { k: 't', day: '2026-10-16', dx: 0, row: null, ry: 1 },
      { k: 'l', fx: 0.2, row: 'r1', ry: 0.5 },
      { k: 'e', key: 'card:add-task', fx: 0.1, fy: 0.9 },
    ];
    for (const at of anchors) {
      vi.advanceTimersByTime(30);
      gateway.cursor(asSocket(socket), { x: 0.5, y: 0.5, at: { ...at, extra: 'dropped' } });
      expect(socket.volatileEmit).toHaveBeenLastCalledWith('cursor', {
        ...who,
        x: 0.5,
        y: 0.5,
        at,
      });
    }
  });

  it('a malformed anchor is dropped, not the cursor', async () => {
    vi.useFakeTimers();
    const { socket, gateway } = await inRoom();
    const bad = [
      'over there',
      null,
      { k: 'x' },
      { k: 't', day: 'soon', dx: 0.5, row: null, ry: 0 },
      { k: 't', day: '2026-10-16', dx: 0.5, row: 42, ry: 0 },
      { k: 't', day: '2026-10-16', dx: 0.5, row: '', ry: 0 },
      { k: 'l', fx: 0.2, row: 'x'.repeat(81), ry: 0.5 },
      { k: 'e', key: 'card', fx: 1.5, fy: 0 },
    ];
    for (const at of bad) {
      vi.advanceTimersByTime(30);
      gateway.cursor(asSocket(socket), { x: 0.5, y: 0.5, at });
      expect(socket.volatileEmit).toHaveBeenLastCalledWith('cursor', { ...who, x: 0.5, y: 0.5 });
    }
    // A hide carries no anchor, even a good one.
    gateway.cursor(asSocket(socket), { x: null, y: null, at: { k: 'l', fx: 0, row: 'r', ry: 0 } });
    expect(socket.volatileEmit).toHaveBeenLastCalledWith('cursor', { ...who, x: null, y: null });
  });
});
