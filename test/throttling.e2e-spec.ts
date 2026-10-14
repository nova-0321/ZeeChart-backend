import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { configureProxy } from '../src/common/proxy.js';
import { EMAIL_LIMIT } from '../src/common/throttling.js';
import { createValidationPipe } from '../src/common/validation.js';
import { SAVE_VERSION_LIMIT } from '../src/revisions/history-limits.js';
import { deleteTestAccounts } from './cleanup.js';

// The rate limits, switched on (the other e2e tests run without them), behind one trusted proxy as
// on Render: the test client plays the proxy, and X-Forwarded-For carries the caller's address.
// Every sign-in here is for an email with no account (401), so nothing needs cleaning up.

describe('Rate limits behind a proxy (e2e)', () => {
  let app: INestApplication | undefined;
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    TRUST_PROXY: process.env.TRUST_PROXY,
    JWT_SECRET: process.env.JWT_SECRET,
  };

  beforeAll(async () => {
    // Before AppModule is loaded: its config is read and checked when it is imported.
    process.env.NODE_ENV = 'development';
    process.env.TRUST_PROXY = '1';
    // Outside tests the app requires a real secret: a throwaway one (nothing outside this test).
    process.env.JWT_SECRET ??= randomBytes(48).toString('base64');
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>();
    configureProxy(nest, nest.get(ConfigService));
    nest.useGlobalPipes(createValidationPipe());
    await nest.listen(0);
    app = nest;
  });

  afterAll(async () => {
    // Undefined when it failed to start: the start's error is the one to read.
    await app?.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const signIn = (from: string, email = `zzthr-${randomUUID()}@example.com`) =>
    request(app!.getHttpServer())
      .post('/auth/signin')
      .set('X-Forwarded-For', from)
      .send({ email, password: 'wrong-password-1' });

  it('counts each caller by its own address, not the proxy', async () => {
    // A: 10 tries a minute (the sign-in limit), then refused.
    for (let i = 0; i < 10; i++) expect((await signIn('203.0.113.1')).status).toBe(401);
    const refused = await signIn('203.0.113.1');
    expect(refused.status).toBe(429);
    expect((refused.body as { message: string }).message).toBe(
      'Too many attempts. Wait a few minutes and try again.',
    );
    // B, behind the same proxy, still has all its tries.
    expect((await signIn('203.0.113.2')).status).toBe(401);
  });

  it('ignores an address the caller made up (only the proxy-added entry counts)', async () => {
    for (let i = 0; i < 10; i++) expect((await signIn('203.0.113.3')).status).toBe(401);
    // The same caller, putting a fresh address in front: the proxy still added the real one last.
    expect((await signIn('198.51.100.7, 203.0.113.3')).status).toBe(429);
  });

  it('limits the tries for one email from any address', async () => {
    const email = `zzthr-victim-${randomUUID()}@example.com`;
    for (let i = 0; i < EMAIL_LIMIT; i++) {
      expect((await signIn(`192.0.2.${i + 1}`, email)).status).toBe(401);
    }
    // A new address doesn't help, nor does changing the case or adding spaces.
    expect((await signIn('192.0.2.200', email)).status).toBe(429);
    expect((await signIn('192.0.2.201', ` ${email.toUpperCase()} `)).status).toBe(429);
    // Another email from those addresses is not affected.
    expect((await signIn('192.0.2.1')).status).toBe(401);
  });
});

describe('"Save a version now" rate limit (e2e)', () => {
  let app: INestApplication | undefined;
  const saved = { NODE_ENV: process.env.NODE_ENV, JWT_SECRET: process.env.JWT_SECRET };

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.JWT_SECRET ??= randomBytes(48).toString('base64');
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>();
    nest.useGlobalPipes(createValidationPipe());
    await nest.listen(0);
    app = nest;
  });

  afterAll(async () => {
    if (app) await deleteTestAccounts(app, 'zzthr-save-');
    await app?.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it(`allows ${SAVE_VERSION_LIMIT} a minute: each one stores the whole project`, async () => {
    const http = () => request(app!.getHttpServer());
    const { accessToken } = (
      await http()
        .post('/auth/signup')
        .send({
          name: 'Saver',
          email: `zzthr-save-${randomUUID()}@example.com`,
          password: 'pass-word-1',
        })
        .expect(201)
    ).body as { accessToken: string };
    const as = (call: request.Test) => call.set('Authorization', `Bearer ${accessToken}`);
    const { id } = (await as(http().post('/projects')).send({ name: `Save ${randomUUID()}` }))
      .body as { id: string };
    for (let i = 0; i < SAVE_VERSION_LIMIT; i++) {
      // Nothing changes, so each keeps v1 (200): it still counts.
      await as(http().post(`/projects/${id}/versions`)).expect(200);
    }
    await as(http().post(`/projects/${id}/versions`)).expect(429);
  });
});
