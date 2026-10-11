import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { isUUID } from 'class-validator';
import type { Server, Socket } from 'socket.io';
import { DataSource } from 'typeorm';
import type { TokenPayload } from '../auth/auth.service.js';
import { User } from '../auth/entities/user.entity.js';
import { roleIn } from '../projects/project-access.js';
import {
  clientRoom,
  isProjectRoom,
  projectOfRoom,
  projectRoom,
  userRoom,
} from './realtime.rooms.js';
import {
  clientIdFrom,
  CURSOR_EVENT,
  type CursorAnchor,
  type CursorMessage,
  PRESENCE_EVENT,
  type PresenceMember,
  type PresenceMessage,
} from './realtime.types.js';

/** The answer to `join` and `leave` (socket.io acknowledgement). */
export type RoomAck = { ok: true } | { ok: false; error: string };

/** What the gateway keeps on each socket. */
interface SocketData {
  /** The signed-in user (from the token it connected with), and their name then. */
  userId: string;
  name: string;
  /** Who it is in the presence list: its client id, or guest:<socket id>. */
  memberId: string;
  /** The project room it is in; still known when it disconnects (its rooms are gone by then). */
  projectId?: string;
  /** When it last passed on a cursor (ms): more than CURSOR_MIN_MS apart, or dropped. */
  cursorAt?: number;
}

/** A tab's cursors are passed on at most this often (a busy or broken client can't flood a room). */
const CURSOR_MIN_MS = 30;

/** A fraction (0..1) and nothing else. */
const unit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
/** A key or row id: a short string. */
const key = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 80;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** What a pointer is over (see CursorAnchor), rebuilt field by field: nothing else passes through. */
const anchor = (value: unknown): CursorAnchor | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const at = value as Record<string, unknown>;
  if (
    at.k === 't' &&
    typeof at.day === 'string' &&
    DAY.test(at.day) &&
    unit(at.dx) &&
    unit(at.ry)
  ) {
    if (at.row !== null && !key(at.row)) return undefined;
    return { k: 't', day: at.day, dx: at.dx, row: at.row, ry: at.ry };
  }
  if (at.k === 'l' && unit(at.fx) && key(at.row) && unit(at.ry)) {
    return { k: 'l', fx: at.fx, row: at.row, ry: at.ry };
  }
  if (at.k === 'e' && key(at.key) && unit(at.fx) && unit(at.fy)) {
    return { k: 'e', key: at.key, fx: at.fx, fy: at.fy };
  }
  return undefined;
};

/** A fraction of the board (0..1), or null (hidden); anything else is not a cursor. */
const fraction = (value: unknown): number | null | undefined =>
  value === null
    ? null
    : typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : undefined;

const dataOf = (socket: Socket) => socket.data as SocketData;

/**
 * The live connection (socket.io, same port as the API). A client signs in with its token
 * (`auth: { token }`), joins the room of a project it is a member of, and is told when something in
 * it changes (see RealtimeService) and who else has it open (presence). A socket is in at most one
 * project room: joining another leaves the previous one. Each socket is also in its user's room,
 * which hears about that person's own memberships (added to or removed from a project).
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  /** The socket.io server: rooms, and sending to them. */
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly db: DataSource,
  ) {}

  /**
   * No connection without a valid token: the client gets `connect_error` with the same message the
   * REST API gives (401).
   */
  afterInit(server: Server) {
    server.use((socket, next) => {
      this.signIn(socket).then(
        () => next(),
        (error: Error) => next(error),
      );
    });
  }

  /**
   * A tab that sends its client id (`auth: { clientId }`) goes in its own room, so its own changes
   * are not sent back to it. Without one (or with junk) it still connects and gets every change.
   */
  async handleConnection(socket: Socket) {
    const clientId = clientIdFrom(
      (socket.handshake.auth as { clientId?: unknown } | undefined)?.clientId,
    );
    dataOf(socket).memberId = clientId ?? `guest:${socket.id}`;
    const rooms = [userRoom(dataOf(socket).userId)];
    if (clientId) rooms.push(clientRoom(clientId));
    await socket.join(rooms);
  }

  /** The others in its project are told it has gone. */
  async handleDisconnect(socket: Socket) {
    const { projectId } = dataOf(socket);
    if (projectId) await this.announce(projectId);
  }

  /** Only a member of the project may join its room; to anyone else it does not exist. */
  @SubscribeMessage('join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<RoomAck> {
    const projectId = (body as { projectId?: unknown } | null)?.projectId;
    if (typeof projectId !== 'string' || !isUUID(projectId)) {
      return { ok: false, error: 'projectId must be a UUID' };
    }
    // The client waits for this answer: a failing check must still give one, not leave it hanging.
    let member: boolean;
    try {
      member = (await roleIn(this.db, projectId, dataOf(socket).userId)) !== null;
    } catch (error) {
      this.logger.error(`Could not check project ${projectId}`, error as Error);
      return { ok: false, error: 'Could not check the project. Try again.' };
    }
    if (!member) return { ok: false, error: `Project ${projectId} not found` };
    const left = await this.leaveProjects(socket, projectRoom(projectId));
    await socket.join(projectRoom(projectId));
    dataOf(socket).projectId = projectId;
    this.logger.debug(`${socket.id} joined ${projectRoom(projectId)}`);
    await Promise.all([projectId, ...left].map((id) => this.announce(id)));
    return { ok: true };
  }

  /**
   * Where this tab's pointer is (see CursorInput): passed to the others in its project room, with
   * who it is. Nothing outside a room, nothing malformed, nothing faster than CURSOR_MIN_MS (but a
   * hide always goes through). No answer: it is sent many times a second.
   */
  @SubscribeMessage(CURSOR_EVENT)
  cursor(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): void {
    const data = dataOf(socket);
    // Not in its room any more (they left the project, or were removed): nothing to show there.
    if (!data.projectId || !socket.rooms.has(projectRoom(data.projectId))) return;
    const input = (body ?? {}) as { x?: unknown; y?: unknown; at?: unknown };
    const [x, y] = [fraction(input.x), fraction(input.y)];
    if (x === undefined || y === undefined || (x === null) !== (y === null)) return;
    const now = Date.now();
    if (x !== null && data.cursorAt !== undefined && now - data.cursorAt < CURSOR_MIN_MS) return;
    data.cursorAt = now;
    const message: CursorMessage = {
      projectId: data.projectId,
      id: data.memberId,
      userId: data.userId,
      name: data.name,
      x,
      y,
    };
    // A malformed anchor is dropped, not the cursor: x and y still place it.
    const at = x === null ? undefined : anchor(input.at);
    if (at) message.at = at;
    // volatile: under load a cursor is dropped rather than queued (the next one replaces it).
    socket.volatile.to(projectRoom(data.projectId)).emit(CURSOR_EVENT, message);
  }

  @SubscribeMessage('leave')
  async leave(@ConnectedSocket() socket: Socket): Promise<RoomAck> {
    const left = await this.leaveProjects(socket);
    dataOf(socket).projectId = undefined;
    await Promise.all(left.map((id) => this.announce(id)));
    return { ok: true };
  }

  /** Who has the project open now: one entry per tab, in the order they came. */
  async membersOf(projectId: string): Promise<PresenceMember[]> {
    const sockets = await this.server.in(projectRoom(projectId)).fetchSockets();
    const tabs = new Map<string, PresenceMember>();
    for (const socket of sockets) {
      const { memberId, userId, name } = socket.data as SocketData;
      if (!tabs.has(memberId)) tabs.set(memberId, { id: memberId, userId, name });
    }
    return [...tabs.values()];
  }

  /**
   * Takes every tab of a user out of a project's room (they are no longer a member), and tells the
   * others there who is left.
   */
  async removeUser(userId: string, projectId: string) {
    this.server.in(userRoom(userId)).socketsLeave(projectRoom(projectId));
    await this.announce(projectId);
  }

  /** The user in the token the socket connected with; throws (refusing it) without a valid one. */
  private async signIn(socket: Socket) {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || !token) throw new Error('Sign in first');
    let userId: string;
    try {
      userId = (await this.jwt.verifyAsync<TokenPayload>(token)).sub;
    } catch {
      // Expired, tampered with, or signed with another secret.
      throw new Error('Your session has ended. Sign in again');
    }
    // The name others see in the presence list. A deleted account is refused, as by the API.
    const user = await this.db
      .getRepository(User)
      .findOne({ select: { name: true }, where: { id: userId } });
    if (!user) throw new Error('Your session has ended. Sign in again');
    dataOf(socket).userId = userId;
    dataOf(socket).name = user.name;
  }

  /** Tells everyone with the project open who has it open. */
  private async announce(projectId: string) {
    const message: PresenceMessage = { projectId, members: await this.membersOf(projectId) };
    this.server.to(projectRoom(projectId)).emit(PRESENCE_EVENT, message);
  }

  /** Leaves every project room but `keep`; answers the projects it left. */
  private async leaveProjects(socket: Socket, keep?: string): Promise<string[]> {
    const left: string[] = [];
    for (const room of [...socket.rooms]) {
      if (isProjectRoom(room) && room !== keep) {
        await socket.leave(room);
        left.push(projectOfRoom(room));
      }
    }
    return left;
  }
}
