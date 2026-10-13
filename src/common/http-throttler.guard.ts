import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * The rate limits, for HTTP requests only. A global guard also runs on every WebSocket message,
 * and ThrottlerGuard is made for HTTP: it writes rate-limit headers on the "response" (for a socket
 * message, its payload: a `leave` without one crashed it), and counts by `req.ip` (a socket has
 * none, so every socket of every user shared one limit). Socket messages have limits of their own
 * in RealtimeGateway.
 */
@Injectable()
export class HttpThrottlerGuard extends ThrottlerGuard {
  protected override shouldSkip(context: ExecutionContext): Promise<boolean> {
    return Promise.resolve(context.getType() !== 'http');
  }
}
