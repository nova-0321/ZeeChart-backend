import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { DataSource } from 'typeorm';
import { isCurrentToken, type TokenPayload } from './token.js';

/** A request that passed AuthGuard: the signed-in user's id. */
export interface AuthedRequest extends Request {
  userId: string;
}

/**
 * Lets a request through only with a valid `Authorization: Bearer <token>` of an account that still
 * exists and has not signed out everywhere since the token was made (see token.ts); 401 otherwise
 * (a deleted account's token is an ended session, not a 409 from a missing row later on). Exported
 * for other modules (permissions, #20).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly db: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Sign in first');
    let payload: TokenPayload;
    try {
      payload = await this.jwt.verifyAsync<TokenPayload>(token);
    } catch {
      // Expired, tampered with, or signed with another secret.
      throw new UnauthorizedException('Your session has ended. Sign in again');
    }
    const rows = await this.db.query<{ tokenVersion: number }[]>(
      'SELECT "tokenVersion" FROM "users" WHERE "id" = $1',
      [payload.sub],
    );
    const account = rows[0];
    if (!account) {
      throw new UnauthorizedException('The account no longer exists. Sign in again');
    }
    // Signed out everywhere since: said as for an expired token (nothing to tell about the account).
    if (!isCurrentToken(payload, account.tokenVersion)) {
      throw new UnauthorizedException('Your session has ended. Sign in again');
    }
    request.userId = payload.sub;
    return true;
  }
}
