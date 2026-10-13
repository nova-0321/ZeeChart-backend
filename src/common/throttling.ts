import { type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';

// Rate limits. `default`: requests per address per minute, plenty for the app and a stop to
// hammering (signing in, invite links and invites have tighter limits of their own: @Throttle).
// `email`: sign-in attempts per email address, from any address, so one account's password can't
// be guessed by spreading the tries over many machines. Both are off in tests, which sign up many
// accounts at once (a test that checks the limits runs with another NODE_ENV).

const BY_EMAIL = 'throttling:by-email';
/** The route also counts its tries per email address (the `email` limit). */
export const ThrottleByEmail = () => SetMetadata(BY_EMAIL, true);

/** Sign-in tries per email address: this many per window. */
export const EMAIL_LIMIT = 10;
export const EMAIL_WINDOW_MS = 15 * 60_000;

export const throttlerOptions = (config: ConfigService): ThrottlerModuleOptions => {
  const inTests = () => config.get<string>('NODE_ENV') === 'test';
  return {
    throttlers: [
      { name: 'default', ttl: 60_000, limit: 600, skipIf: inTests },
      {
        name: 'email',
        ttl: EMAIL_WINDOW_MS,
        limit: EMAIL_LIMIT,
        // A limit's own skipIf replaces the shared one, so tests are checked here too.
        skipIf: (context: ExecutionContext) =>
          inTests() ||
          context.getType() !== 'http' ||
          Reflect.getMetadata(BY_EMAIL, context.getHandler()) !== true,
        getTracker: (req: Record<string, unknown>) => {
          const email = (req.body as { email?: unknown } | undefined)?.email;
          return `email:${typeof email === 'string' ? email.trim().toLowerCase() : ''}`;
        },
      },
    ],
    errorMessage: 'Too many attempts. Wait a few minutes and try again.',
  };
};
