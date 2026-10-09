import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { isUUID } from 'class-validator';
import type { Server, Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { Project } from '../projects/entities/project.entity.js';
import { clientRoom, isProjectRoom, projectOfRoom, projectRoom } from './realtime.rooms.js';
import { clientIdFrom, PRESENCE_EVENT, type PresenceMessage } from './realtime.types.js';

/** The answer to `join` and `leave` (socket.io acknowledgement). */
export type RoomAck = { ok: true } | { ok: false; error: string };

/** What the gateway keeps on each socket. */
interface SocketData {
  /** Who it is in the presence list: its client id, or guest:<socket id>. */
  memberId: string;
  /** The project room it is in; still known when it disconnects (its rooms are gone by then). */
  projectId?: string;
}

const dataOf = (socket: Socket) => socket.data as SocketData;

/**
 * The live connection (socket.io, same port as the API). A client joins the room of the project it
 * has open and is told when something in it changes (see RealtimeService), and who else has it open
 * (presence). A socket is in at most one project room: joining another leaves the previous one.
 *
 * No sign-in yet: anyone who can reach the API can join any project's room, as with the REST API.
 * When sign-in and members (#18) come, the checks go in handleConnection and join, and presence can
 * name people instead of tabs.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  /** The socket.io server: rooms, and sending to them. */
  @WebSocketServer()
  server: Server;

  constructor(
    @InjectRepository(Project)
    private readonly projects: Repository<Project>,
  ) {}

  /**
   * A tab that sends its client id (`auth: { clientId }`) goes in its own room, so its own changes
   * are not sent back to it. Without one (or with junk) it still connects and gets every change.
   */
  async handleConnection(socket: Socket) {
    const clientId = clientIdFrom(
      (socket.handshake.auth as { clientId?: unknown } | undefined)?.clientId,
    );
    dataOf(socket).memberId = clientId ?? `guest:${socket.id}`;
    if (clientId) await socket.join(clientRoom(clientId));
  }

  /** The others in its project are told it has gone. */
  async handleDisconnect(socket: Socket) {
    const { projectId } = dataOf(socket);
    if (projectId) await this.announce(projectId);
  }

  @SubscribeMessage('join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<RoomAck> {
    const projectId = (body as { projectId?: unknown } | null)?.projectId;
    if (typeof projectId !== 'string' || !isUUID(projectId)) {
      return { ok: false, error: 'projectId must be a UUID' };
    }
    if (!(await this.projects.existsBy({ id: projectId }))) {
      return { ok: false, error: `Project ${projectId} not found` };
    }
    const left = await this.leaveProjects(socket, projectRoom(projectId));
    await socket.join(projectRoom(projectId));
    dataOf(socket).projectId = projectId;
    this.logger.debug(`${socket.id} joined ${projectRoom(projectId)}`);
    await Promise.all([projectId, ...left].map((id) => this.announce(id)));
    return { ok: true };
  }

  @SubscribeMessage('leave')
  async leave(@ConnectedSocket() socket: Socket): Promise<RoomAck> {
    const left = await this.leaveProjects(socket);
    dataOf(socket).projectId = undefined;
    await Promise.all(left.map((id) => this.announce(id)));
    return { ok: true };
  }

  /** Who has the project open now, as a list of member ids (one per tab, in the order they came). */
  async membersOf(projectId: string): Promise<string[]> {
    const sockets = await this.server.in(projectRoom(projectId)).fetchSockets();
    return [...new Set(sockets.map((socket) => (socket.data as SocketData).memberId))];
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
