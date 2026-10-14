import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { User } from './entities/user.entity.js';
import { hashPassword, needsRehash, verifyPassword } from './password.js';
import { hashWith } from '../../test/password-hashes.js';
import { SessionEvents } from './token.js';

const SECRET = 'test-secret-at-least-16';
const ada = { name: 'Ada', email: 'ada@x.io', password: 'pass-word-1' };

describe('AuthService', () => {
  let service: AuthService;
  let jwt: JwtService;
  let sessions: SessionEvents;
  const repo = {
    existsBy: vi.fn(),
    create: vi.fn((user: Partial<User>) => ({ ...user })),
    save: vi.fn(),
    findOne: vi.fn(),
    findOneBy: vi.fn(),
    update: vi.fn(),
    increment: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations set by an earlier test: back to a plain success.
    repo.increment.mockResolvedValue(undefined);
    jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '1h' } });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: repo },
        { provide: JwtService, useValue: jwt },
        SessionEvents,
      ],
    }).compile();
    service = module.get(AuthService);
    sessions = module.get(SessionEvents);
  });

  it('sign-up stores a hash (not the password) and answers a token for the new user', async () => {
    repo.existsBy.mockResolvedValue(false);
    repo.save.mockImplementation((user: User) =>
      Promise.resolve(Object.assign(user, { id: 'u1', createdAt: new Date() })),
    );
    const result = await service.signUp(ada);
    const saved = repo.save.mock.calls[0]![0] as User;
    expect(saved.passwordHash).toMatch(/^scrypt\$/);
    expect(JSON.stringify(saved)).not.toContain(ada.password);
    expect(result.user).toEqual({
      id: 'u1',
      name: 'Ada',
      email: 'ada@x.io',
      createdAt: saved.createdAt,
    });
    expect(result.user).not.toHaveProperty('passwordHash');
    await expect(jwt.verifyAsync(result.accessToken)).resolves.toMatchObject({ sub: 'u1' });
  });

  it('sign-up with a taken email is a 409, and saves nothing', async () => {
    repo.existsBy.mockResolvedValue(true);
    await expect(service.signUp(ada)).rejects.toBeInstanceOf(ConflictException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('two sign-ups at once: the database unique rule gives a 409 too', async () => {
    repo.existsBy.mockResolvedValue(false);
    repo.save.mockRejectedValue(
      new QueryFailedError('INSERT', [], Object.assign(new Error('dup'), { code: '23505' })),
    );
    await expect(service.signUp(ada)).rejects.toBeInstanceOf(ConflictException);
  });

  it('sign-in: the right password gives a token; a wrong password and an unknown email give the same 401', async () => {
    const passwordHash = await hashPassword(ada.password);
    repo.findOne.mockResolvedValue({
      id: 'u1',
      name: 'Ada',
      email: ada.email,
      createdAt: new Date(),
      passwordHash,
    });
    const ok = await service.signIn({ email: ada.email, password: ada.password });
    await expect(jwt.verifyAsync(ok.accessToken)).resolves.toMatchObject({ sub: 'u1' });
    expect(ok.user).not.toHaveProperty('passwordHash');

    const wrong = service.signIn({ email: ada.email, password: 'nope-nope-1' });
    await expect(wrong).rejects.toBeInstanceOf(UnauthorizedException);
    repo.findOne.mockResolvedValue(null);
    const unknown = service.signIn({ email: 'who@x.io', password: ada.password });
    await expect(unknown).rejects.toBeInstanceOf(UnauthorizedException);
    const messages = await Promise.all(
      [wrong, unknown].map((p) => p.catch((error: Error) => error.message)),
    );
    expect(messages[0]).toBe(messages[1]);
  });

  describe('sign-in moves old password hashes to the current settings', () => {
    const user = (passwordHash: string) => ({
      id: 'u1',
      name: 'Ada',
      email: ada.email,
      createdAt: new Date(),
      passwordHash,
    });

    it('replaces a hash made with weaker settings, only if it is still the one checked', async () => {
      const old = await hashWith(ada.password, 16384, 8, 1);
      repo.findOne.mockResolvedValue(user(old));
      const result = await service.signIn({ email: ada.email, password: ada.password });
      await expect(jwt.verifyAsync(result.accessToken)).resolves.toMatchObject({ sub: 'u1' });
      expect(repo.update).toHaveBeenCalledTimes(1);
      const [where, set] = repo.update.mock.calls[0] as [
        { id: string; passwordHash: string },
        { passwordHash: string },
      ];
      expect(where).toEqual({ id: 'u1', passwordHash: old });
      expect(needsRehash(set.passwordHash)).toBe(false);
      await expect(verifyPassword(ada.password, set.passwordHash)).resolves.toBe(true);
    });

    it('leaves a current hash alone', async () => {
      repo.findOne.mockResolvedValue(user(await hashPassword(ada.password)));
      await service.signIn({ email: ada.email, password: ada.password });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('changes nothing for a wrong password or an unknown email', async () => {
      repo.findOne.mockResolvedValue(user(await hashWith(ada.password, 16384, 8, 1)));
      await expect(service.signIn({ email: ada.email, password: 'nope-nope-1' })).rejects.toThrow();
      repo.findOne.mockResolvedValue(null);
      await expect(service.signIn({ email: 'who@x.io', password: ada.password })).rejects.toThrow();
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('still signs in when the replacement cannot be saved', async () => {
      repo.findOne.mockResolvedValue(user(await hashWith(ada.password, 16384, 8, 1)));
      repo.update.mockRejectedValue(new Error('db down'));
      const result = await service.signIn({ email: ada.email, password: ada.password });
      await expect(jwt.verifyAsync(result.accessToken)).resolves.toMatchObject({ sub: 'u1' });
    });
  });

  describe('sessions that can be ended (tokenVersion)', () => {
    it('puts the tokenVersion of the account in the token it makes', async () => {
      repo.findOne.mockResolvedValue({
        id: 'u1',
        name: 'Ada',
        email: ada.email,
        createdAt: new Date(),
        tokenVersion: 4,
        passwordHash: await hashPassword(ada.password),
      });
      const result = await service.signIn({ email: ada.email, password: ada.password });
      await expect(jwt.verifyAsync(result.accessToken)).resolves.toMatchObject({
        sub: 'u1',
        tv: 4,
      });
    });

    it('a new account starts at 0', async () => {
      repo.existsBy.mockResolvedValue(false);
      repo.save.mockImplementation((user: User) => Promise.resolve({ ...user, id: 'u9' }));
      const result = await service.signUp(ada);
      await expect(jwt.verifyAsync(result.accessToken)).resolves.toMatchObject({ tv: 0 });
    });

    it('signing out everywhere raises the number by one, and tells the live connection', async () => {
      const heard: string[] = [];
      sessions.onRevoked((userId) => heard.push(userId));
      await service.signOutEverywhere('u1');
      expect(repo.increment).toHaveBeenCalledWith({ id: 'u1' }, 'tokenVersion', 1);
      expect(heard).toEqual(['u1']);
    });

    it('does not tell anyone when the number could not be raised', async () => {
      const heard: string[] = [];
      sessions.onRevoked((userId) => heard.push(userId));
      repo.increment.mockRejectedValue(new Error('db down'));
      await expect(service.signOutEverywhere('u1')).rejects.toThrow('db down');
      expect(heard).toEqual([]);
    });

    it('a listener that fails does not fail the request that ended the sign-ins', async () => {
      sessions.onRevoked(() => {
        throw new Error('listener broke');
      });
      const heard: string[] = [];
      sessions.onRevoked((userId) => heard.push(userId));
      await expect(service.signOutEverywhere('u1')).resolves.toBeUndefined();
      expect(heard).toEqual(['u1']);
    });
  });

  it('me: the user, or a 401 when the account no longer exists', async () => {
    repo.findOneBy.mockResolvedValue({
      id: 'u1',
      name: 'Ada',
      email: ada.email,
      createdAt: new Date(),
    });
    await expect(service.me('u1')).resolves.toMatchObject({ id: 'u1', name: 'Ada' });
    repo.findOneBy.mockResolvedValue(null);
    await expect(service.me('gone')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AuthGuard', () => {
  const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '1h' } });
  // The account of a valid token exists (one query answering a row).
  const db = { query: vi.fn().mockResolvedValue([{ tokenVersion: 0 }]) };
  const guard = new AuthGuard(jwt, db as never);
  const contextWith = (authorization?: string) => {
    const request: { headers: { authorization?: string }; userId?: string } = {
      headers: { authorization },
    };
    return {
      request,
      context: { switchToHttp: () => ({ getRequest: () => request }) } as never,
    };
  };

  it('lets a valid Bearer token through and gives the user id', async () => {
    const { request, context } = contextWith(`Bearer ${await jwt.signAsync({ sub: 'u1' })}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.userId).toBe('u1');
  });

  it('refuses a valid token whose account is gone (401, not an error later on)', async () => {
    db.query.mockResolvedValueOnce([]);
    const { context } = contextWith(`Bearer ${await jwt.signAsync({ sub: 'gone' })}`);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('signing out everywhere (tokenVersion)', () => {
    const tryToken = async (claims: object, accountVersion: number) => {
      db.query.mockResolvedValueOnce([{ tokenVersion: accountVersion }]);
      const { request, context } = contextWith(`Bearer ${await jwt.signAsync(claims)}`);
      return { result: guard.canActivate(context), request };
    };

    it('lets a token through while its number is the one of the account', async () => {
      const { result, request } = await tryToken({ sub: 'u1', tv: 3 }, 3);
      await expect(result).resolves.toBe(true);
      expect(request.userId).toBe('u1');
    });

    it('refuses a token made before the account signed out everywhere (401)', async () => {
      const { result } = await tryToken({ sub: 'u1', tv: 3 }, 4);
      await expect(result).rejects.toBeInstanceOf(UnauthorizedException);
      await expect((await tryToken({ sub: 'u1', tv: 0 }, 1)).result).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('refuses a token with a number the account has not reached (a made-up one)', async () => {
      const { result } = await tryToken({ sub: 'u1', tv: 9 }, 3);
      await expect(result).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('a token made before the number existed counts as 0: fine until the first sign-out', async () => {
      await expect((await tryToken({ sub: 'u1' }, 0)).result).resolves.toBe(true);
      await expect((await tryToken({ sub: 'u1' }, 1)).result).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('says the same as for an expired token, so it tells nothing about the account', async () => {
      const revoked = (await tryToken({ sub: 'u1', tv: 0 }, 1)).result;
      const expired = guard.canActivate(
        contextWith(`Bearer ${await jwt.signAsync({ sub: 'u1' }, { expiresIn: -10 })}`).context,
      );
      const messages = await Promise.all(
        [revoked, expired].map((p) => p.catch((error: Error) => error.message)),
      );
      expect(messages[0]).toBe(messages[1]);
    });
  });

  it('refuses no token, another scheme, a forged token and an expired one', async () => {
    const forged = await new JwtService({ secret: 'another-secret-16chars' }).signAsync({
      sub: 'u1',
    });
    const expired = await jwt.signAsync({ sub: 'u1' }, { expiresIn: -10 });
    for (const header of [
      undefined,
      'Basic abc',
      'Bearer',
      `Bearer ${forged}`,
      `Bearer ${expired}`,
    ]) {
      await expect(guard.canActivate(contextWith(header).context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
  });
});
