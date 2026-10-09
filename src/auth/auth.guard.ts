import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { TokenPayload } from './auth.service.js';

/** A request that passed AuthGuard: the signed-in user's id. */
export interface AuthedRequest extends Request {
  userId: string;
}

/**
 * Lets a request through only with a valid `Authorization: Bearer <token>`; 401 otherwise.
 * Exported for other modules (permissions, #20).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Sign in first');
    try {
      const payload = await this.jwt.verifyAsync<TokenPayload>(token);
      request.userId = payload.sub;
    } catch {
      // Expired, tampered with, or signed with another secret.
      throw new UnauthorizedException('Your session has ended. Sign in again');
    }
    return true;
  }
}
