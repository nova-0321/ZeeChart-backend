import { Injectable, Logger } from '@nestjs/common';

/**
 * What a sign-in token carries: the user's id in `sub`, and in `tv` the account's `tokenVersion`
 * when the token was made. Tokens made before `tv` existed have none, which counts as 0 (the
 * number every account started with), so they keep working until the account signs out everywhere.
 */
export interface TokenPayload {
  sub: string;
  tv?: number;
}

/**
 * Whether a token is still good for an account: it was made with the account's current
 * `tokenVersion`. Signing out everywhere raises the number, which ends every earlier token at once
 * (a JWT can't be taken back, so the check is made on each request and when a socket connects).
 */
export const isCurrentToken = (payload: TokenPayload, tokenVersion: number) =>
  (payload.tv ?? 0) === tokenVersion;

/**
 * "This account's sign-ins were all ended": told by AuthService, heard by the live connection
 * (RealtimeGateway), which closes that person's open sockets. The realtime module already depends
 * on the auth module, so auth can't call it directly; this is the shared, neutral place.
 */
@Injectable()
export class SessionEvents {
  private readonly logger = new Logger(SessionEvents.name);
  private readonly listeners = new Set<(userId: string) => void>();

  /** Call `listener` whenever an account's sign-ins are ended. Returns the function that stops it. */
  onRevoked(listener: (userId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Never throws: the listeners' trouble must not fail the request that ended the sign-ins. */
  revoked(userId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(userId);
      } catch (error) {
        this.logger.error(`A listener failed for ${userId}`, error as Error);
      }
    }
  }
}
