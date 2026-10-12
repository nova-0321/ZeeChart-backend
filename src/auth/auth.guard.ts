import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { DataSource } from 'typeorm';
import type { TokenPayload } from './auth.service.js';

/** A request that passed AuthGuard: the signed-in user's id. */
export interface AuthedRequest extends Request {
  userId: string;
}

/**
 * Lets a request through only with a valid `Authorization: Bearer <token>` of an account that still
 * exists; 401 otherwise (a deleted account's token is an ended session, not a 409 from a missing
 * row later on). Exported for other modules (permissions, #20).
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
    let userId: string;
    try {
      userId = (await this.jwt.verifyAsync<TokenPayload>(token)).sub;
    } catch {
      // Expired, tampered with, or signed with another secret.
      throw new UnauthorizedException('Your session has ended. Sign in again');
    }
    const exists = await this.db.query<unknown[]>('SELECT 1 FROM "users" WHERE "id" = $1', [
      userId,
    ]);
    if (exists.length === 0) {
      throw new UnauthorizedException('The account no longer exists. Sign in again');
    }
    request.userId = userId;
    return true;
  }
}
