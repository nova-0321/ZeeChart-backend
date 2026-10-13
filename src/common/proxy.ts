import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

/**
 * Behind a proxy (Render's load balancer) every request arrives from the proxy's address; the
 * caller's is in X-Forwarded-For. Trusting the configured number of proxies (TRUST_PROXY) makes
 * `req.ip` the caller's, which the rate limits count by. Used by main.ts and the e2e tests alike.
 */
export function configureProxy(app: NestExpressApplication, config: ConfigService) {
  const hops = config.get<number | false>('TRUST_PROXY') ?? false;
  app.set('trust proxy', hops);
  // Once per start: what the server takes as the caller's address, next to what the proxies sent,
  // to check TRUST_PROXY against your own address after a deploy (only the first request).
  let logged = false;
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (!logged) {
      logged = true;
      new Logger('Proxy').log(
        `TRUST_PROXY=${hops}: client address ${req.ip}; X-Forwarded-For: ${req.headers['x-forwarded-for'] ?? '(none)'}`,
      );
    }
    next();
  });
}
