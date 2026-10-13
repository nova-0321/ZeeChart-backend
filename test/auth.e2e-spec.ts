import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Like, type Repository } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { User } from '../src/auth/entities/user.entity.js';
import { createValidationPipe } from '../src/common/validation.js';

// Sign up, sign in and "who am I" against the real app and database.

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let users: Repository<User>;
  const http = () => request(app.getHttpServer());
  /** A fresh address per test, cleaned up afterwards. */
  const email = () => `zzauth-${randomUUID()}@example.com`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // As main.ts sets the app up.
    app.useGlobalPipes(createValidationPipe());
    // Listening on a port of its own: supertest then reuses it, instead of opening and closing a
    // temporary one for every request (which can refuse a request sent right after another).
    await app.listen(0);
    users = app.get(getRepositoryToken(User));
  });

  afterAll(async () => {
    await users.delete({ email: Like('zzauth-%') });
    await app.close();
  });

  it('sign up, then "me" with the token, then sign in again', async () => {
    const address = email();
    const signedUp = await http()
      .post('/auth/signup')
      .send({ name: '  Ada  ', email: `  ${address.toUpperCase()} `, password: 'pass-word-1' })
      .expect(201);
    const body = signedUp.body as { accessToken: string; user: Record<string, unknown> };
    expect(body.user).toMatchObject({ name: 'Ada', email: address });
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(typeof body.accessToken).toBe('string');

    const me = await http()
      .get('/auth/me')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(200);
    expect(me.body).toEqual(body.user);

    const signedIn = await http()
      .post('/auth/signin')
      .send({ email: address, password: 'pass-word-1' })
      .expect(200);
    expect((signedIn.body as { user: { id: string } }).user.id).toBe(body.user.id);
  });

  it('stores a hash, never the password', async () => {
    const address = email();
    await http()
      .post('/auth/signup')
      .send({ name: 'Bo', email: address, password: 'pass-word-1' })
      .expect(201);
    const row = await users.findOne({ where: { email: address }, select: { passwordHash: true } });
    expect(row?.passwordHash).toMatch(/^scrypt\$/);
    expect(row?.passwordHash).not.toContain('pass-word-1');
  });

  it('a taken email (in any case) is a 409', async () => {
    const address = email();
    await http()
      .post('/auth/signup')
      .send({ name: 'Cy', email: address, password: 'pass-word-1' })
      .expect(201);
    const again = await http()
      .post('/auth/signup')
      .send({ name: 'Cy', email: address.toUpperCase(), password: 'pass-word-2' })
      .expect(409);
    expect((again.body as { message: string }).message).toBe(
      'An account with this email already exists',
    );
  });

  it('bad input is a 400 listing every problem', async () => {
    const bad = await http()
      .post('/auth/signup')
      .send({ name: '   ', email: 'nope', password: 'short' })
      .expect(400);
    expect((bad.body as { message: string[] }).message).toEqual(
      expect.arrayContaining([
        'name should not be empty',
        'email must be a valid email address',
        'password must be at least 8 characters',
      ]),
    );
  });

  it('a wrong password and an unknown email get the same 401', async () => {
    const address = email();
    await http()
      .post('/auth/signup')
      .send({ name: 'Di', email: address, password: 'pass-word-1' })
      .expect(201);
    const wrong = await http()
      .post('/auth/signin')
      .send({ email: address, password: 'wrong-pass-1' })
      .expect(401);
    const unknown = await http()
      .post('/auth/signin')
      .send({ email: email(), password: 'wrong-pass-1' })
      .expect(401);
    expect((wrong.body as { message: string }).message).toBe('The email or password is incorrect');
    expect((unknown.body as { message: string }).message).toBe(
      (wrong.body as { message: string }).message,
    );
  });

  it('"me" without a valid token, or for a deleted account, is a 401', async () => {
    await http().get('/auth/me').expect(401);
    await http().get('/auth/me').set('Authorization', 'Bearer not-a-token').expect(401);
    await http().get('/auth/me').set('Authorization', 'Basic abc').expect(401);
    const address = email();
    const signedUp = await http()
      .post('/auth/signup')
      .send({ name: 'Ed', email: address, password: 'pass-word-1' })
      .expect(201);
    await users.delete({ email: address });
    await http()
      .get('/auth/me')
      .set('Authorization', `Bearer ${(signedUp.body as { accessToken: string }).accessToken}`)
      .expect(401);
  });
});
