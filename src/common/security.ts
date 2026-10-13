import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { createOpenApiDocument } from '../openapi/openapi.js';

/** Where the API docs are served: the Swagger UI, and the raw spec at `${DOCS_PATH}-json`. */
export const DOCS_PATH = 'docs';

/**
 * Security headers on every response (helmet: no X-Powered-By, nosniff, HSTS, frame and resource
 * policies, a strict Content-Security-Policy...), and the API docs only where API_DOCS allows
 * (off in production by default: the full map of the API need not be public). The Swagger UI
 * runs inline scripts, so its pages go without the CSP. Used by main.ts and the e2e tests alike.
 */
export function configureSecurity(app: INestApplication, config: ConfigService) {
  const docs = config.get<boolean>('API_DOCS') === true;
  const strict = helmet();
  const forDocs = helmet({ contentSecurityPolicy: false });
  // /docs, /docs/... and /docs-json; only while they are served.
  const isDocs = (path: string) => docs && path.startsWith(`/${DOCS_PATH}`);
  app.use((req: Request, res: Response, next: NextFunction) =>
    (isDocs(req.path) ? forDocs : strict)(req, res, next),
  );
  if (docs) {
    // Swagger UI at /docs, raw spec at /docs-json.
    SwaggerModule.setup(DOCS_PATH, app, () => createOpenApiDocument(app));
  }
}
