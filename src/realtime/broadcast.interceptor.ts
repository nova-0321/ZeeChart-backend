import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { from, type Observable, switchMap, tap } from 'rxjs';
import { DataSource } from 'typeorm';
import { BROADCAST, type BroadcastOptions } from './broadcast.decorator.js';
import { RealtimeService } from './realtime.service.js';
import { CLIENT_ID_HEADER, clientIdFrom, type ChangeMessage } from './realtime.types.js';

const isServerError = (error: unknown) =>
  !(error instanceof HttpException) || error.getStatus() >= 500;

/**
 * Sends one change message per @Broadcast request, after it has finished: every transaction in it
 * has committed by then, and an action of several saves (a date edit that refits groups and moves
 * linked tasks) is still one message. The tab that made the change (X-Client-Id) is skipped.
 *
 * - success: { entity, action, id }
 * - 4xx: nothing (refused before anything was saved)
 * - 5xx: { action: 'resync' }: it may have saved part of its work, so the others load again
 */
@Injectable()
export class BroadcastInterceptor implements NestInterceptor {
  private readonly logger = new Logger(BroadcastInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly db: DataSource,
    private readonly realtime: RealtimeService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<BroadcastOptions | undefined>(
      BROADCAST,
      context.getHandler(),
    );
    if (!options || context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const sender = clientIdFrom(request.headers[CLIENT_ID_HEADER]);
    const userId = (request as Request & { userId?: string }).userId;

    return from(this.locate(options, request)).pipe(
      switchMap((projectId) =>
        next.handle().pipe(
          tap({
            next: (body: unknown) => {
              // A create finds its project in the body; the new row's id is in the answer.
              const id = options.action === 'create' ? idOf(body) : text(request.params.id);
              const project = projectId ?? projectOfBody(body);
              if (project) {
                this.send(
                  { projectId: project, entity: options.entity, action: options.action, id },
                  sender,
                  userId,
                );
              }
            },
            error: (error: unknown) => {
              if (projectId && isServerError(error)) {
                this.send({ projectId, entity: options.entity, action: 'resync' }, sender, userId);
              }
            },
          }),
        ),
      ),
    );
  }

  private async locate(options: BroadcastOptions, request: Request) {
    try {
      return await options.project(request, this.db);
    } catch (error) {
      // Not finding the project must never fail the request: it only means no message.
      this.logger.warn(`Could not find the project of ${request.method} ${request.url}`, error);
      return undefined;
    }
  }

  /** After the answer has gone out: sending never delays it. */
  private send(message: ChangeMessage, sender: string | undefined, userId: string | undefined) {
    setImmediate(() => {
      // Only the requester's own tab is skipped: the room is under their user (see clientRoom).
      this.realtime.notify(message, { userId, clientId: sender });
    });
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
const idOf = (body: unknown) => text((body as { id?: unknown } | null | undefined)?.id);
const projectOfBody = (body: unknown) =>
  text((body as { projectId?: unknown } | null | undefined)?.projectId);
