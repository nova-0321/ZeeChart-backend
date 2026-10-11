import { Injectable, Logger } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway.js';
import { clientRoom, projectRoom, userRoom } from './realtime.rooms.js';
import { CHANGED_EVENT, clientIdFrom, type ChangeMessage } from './realtime.types.js';

/** The only place that sends change messages. */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(private readonly gateway: RealtimeGateway) {}

  /**
   * Tell everyone with the project open that something changed, except the tab `exceptClientId`
   * (the one that made the change). Call only after the change is saved. Never throws: a message
   * that can't be sent must not fail the request that saved the change.
   */
  notify(message: ChangeMessage, exceptClientId?: unknown): void {
    const server = this.gateway.server;
    // No socket server (an app context without the live connection, e.g. some tests).
    if (!server) return;
    try {
      const except = clientIdFrom(exceptClientId);
      const room = server.to(projectRoom(message.projectId));
      (except ? room.except(clientRoom(except)) : room).emit(CHANGED_EVENT, message);
    } catch (error) {
      this.logger.error(`Could not send ${JSON.stringify(message)}`, error as Error);
    }
  }

  /**
   * The tab id a request said it came from, if a tab with that id is connected as the same user;
   * otherwise undefined (no tab is skipped). Never throws.
   */
  async clientOf(clientId: string | undefined, userId: string | undefined) {
    const server = this.gateway.server;
    if (!clientId || !userId || !server) return undefined;
    try {
      const sockets = await server.in(clientRoom(clientId)).fetchSockets();
      return sockets.some((socket) => (socket.data as { userId?: string }).userId === userId)
        ? clientId
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Tell every tab of one person about a change to their own membership, whatever project they
   * have open (they were added to a project they aren't in yet, or removed from one). Never throws.
   */
  notifyUser(userId: string, message: ChangeMessage): void {
    const server = this.gateway.server;
    if (!server) return;
    try {
      server.to(userRoom(userId)).emit(CHANGED_EVENT, message);
    } catch (error) {
      this.logger.error(`Could not send ${JSON.stringify(message)} to ${userId}`, error as Error);
    }
  }

  /**
   * Someone is no longer a member: their tabs leave the project's room (they hear nothing more
   * about it) and the others there are told who is left. Never throws.
   */
  async removeFromProject(userId: string, projectId: string): Promise<void> {
    if (!this.gateway.server) return;
    try {
      await this.gateway.removeUser(userId, projectId);
    } catch (error) {
      this.logger.error(`Could not take ${userId} out of ${projectId}`, error as Error);
    }
  }
}
