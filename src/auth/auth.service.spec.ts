import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { User } from './entities/user.entity.js';
import { hashPassword } from './password.js';

const SECRET = 'test-secret-at-least-16';
const ada = { name: 'Ada', email: 'ada@x.io', password: 'pass-word-1' };

describe('AuthService', () => {
  let service: AuthService;
  let jwt: JwtService;
  const repo = {
    existsBy: vi.fn(),
    create: vi.fn((user: Partial<User>) => ({ ...user })),
    save: vi.fn(),
    findOne: vi.fn(),
    findOneBy: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '1h' } });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: repo },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();
    service = module.get(AuthService);
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
  const db = { query: vi.fn().mockResolvedValue([{}]) };
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
