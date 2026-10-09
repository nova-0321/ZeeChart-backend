import { Injectable, Logger } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway.js';
import { clientRoom, projectRoom } from './realtime.rooms.js';
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
}
