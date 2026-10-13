import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureSecurity } from '../src/common/security.js';

// Security headers on every response, and the API docs only where API_DOCS allows. Two apps, set up
// as main.ts does (configureSecurity), one with the docs and one without (as in production).

describe('Security headers and API docs (e2e)', () => {
  const apps: Record<'docs' | 'noDocs', INestApplication> = {} as never;
  const start = async (apiDocs: boolean) => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    const config = app.get(ConfigService);
    // The real config, but API_DOCS as this app needs it.
    configureSecurity(app, {
      get: (key: string) => (key === 'API_DOCS' ? apiDocs : config.get(key)),
    } as ConfigService);
    await app.listen(0);
    return app;
  };

  beforeAll(async () => {
    apps.docs = await start(true);
    apps.noDocs = await start(false);
  });

  afterAll(async () => {
    await Promise.all(Object.values(apps).map((app) => app.close()));
  });

  it('sends security headers and hides the server software', async () => {
    const response = await request(apps.noDocs.getHttpServer()).get('/health').expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('keeps the headers on errors too', async () => {
    const response = await request(apps.noDocs.getHttpServer()).get('/projects').expect(401);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('does not serve the docs when API_DOCS is off (production)', async () => {
    const server = apps.noDocs.getHttpServer();
    await request(server).get('/docs').expect(404);
    await request(server).get('/docs-json').expect(404);
  });

  it('serves the docs when API_DOCS is on, the UI without the strict CSP', async () => {
    const server = apps.docs.getHttpServer();
    const ui = await request(server).get('/docs').redirects(1).expect(200);
    expect(ui.text).toContain('swagger');
    // Its inline scripts need the CSP off on these pages; other headers stay.
    expect(ui.headers['content-security-policy']).toBeUndefined();
    expect(ui.headers['x-content-type-options']).toBe('nosniff');
    const spec = await request(server).get('/docs-json').expect(200);
    expect((spec.body as { openapi: string }).openapi).toMatch(/^3\./);
    // The rest of the API keeps the strict CSP even with the docs on.
    const health = await request(server).get('/health').expect(200);
    expect(health.headers['content-security-policy']).toContain("default-src 'self'");
  });
});
