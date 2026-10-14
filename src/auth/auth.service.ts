import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import type { AuthResponseDto, AuthUserDto } from './dto/auth-response.dto.js';
import type { SignInDto } from './dto/sign-in.dto.js';
import type { SignUpDto } from './dto/sign-up.dto.js';
import { User } from './entities/user.entity.js';
import { dummyPasswordHash, hashPassword, needsRehash, verifyPassword } from './password.js';
import { SessionEvents, type TokenPayload } from './token.js';

const EMAIL_TAKEN = 'An account with this email already exists';
// One message for a wrong email and a wrong password: the answer does not tell which emails
// have accounts.
const BAD_CREDENTIALS = 'The email or password is incorrect';

const isUniqueViolation = (error: unknown) =>
  error instanceof QueryFailedError && (error.driverError as { code?: string }).code === '23505';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly jwt: JwtService,
    private readonly sessions: SessionEvents,
  ) {}

  async signUp(dto: SignUpDto): Promise<AuthResponseDto> {
    if (await this.users.existsBy({ email: dto.email })) throw new ConflictException(EMAIL_TAKEN);
    const user = this.users.create({
      name: dto.name,
      email: dto.email,
      passwordHash: await hashPassword(dto.password),
    });
    try {
      await this.users.save(user);
    } catch (error) {
      // Two sign-ups with the same email at once: the database's unique rule decides.
      if (isUniqueViolation(error)) throw new ConflictException(EMAIL_TAKEN);
      throw error;
    }
    return this.issue(user);
  }

  async signIn(dto: SignInDto): Promise<AuthResponseDto> {
    const user = await this.users.findOne({
      where: { email: dto.email },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        passwordHash: true,
        tokenVersion: true,
      },
    });
    // An unknown email still costs one hash check (see dummyPasswordHash).
    const ok = await verifyPassword(
      dto.password,
      user?.passwordHash ?? (await dummyPasswordHash()),
    );
    if (!user || !ok) throw new UnauthorizedException(BAD_CREDENTIALS);
    await this.upgradeHash(user, dto.password);
    return this.issue(user);
  }

  /**
   * A hash made with weaker settings than today's (see password.ts) is replaced now that the
   * password is at hand. Only if it is still the one that was checked, so a newer one is never
   * overwritten; and a failure here never stops the sign-in, the old hash still works.
   */
  private async upgradeHash(user: User, password: string) {
    if (!needsRehash(user.passwordHash)) return;
    try {
      await this.users.update(
        { id: user.id, passwordHash: user.passwordHash },
        { passwordHash: await hashPassword(password) },
      );
    } catch (error) {
      this.logger.warn(`Could not upgrade the password hash of ${user.id}: ${String(error)}`);
    }
  }

  async me(id: string): Promise<AuthUserDto> {
    const user = await this.users.findOneBy({ id });
    // The token is valid but its account is gone: the same as an ended session.
    if (!user) throw new UnauthorizedException('The account no longer exists. Sign in again');
    return toAuthUser(user);
  }

  /**
   * Ends every sign-in of this account, this one too: tokens made so far stop working (their
   * `tokenVersion` is no longer the account's), and its open live connections are closed. The one
   * place to call when a password changes, too. Atomic: two at once raise it twice, never lose one.
   */
  async signOutEverywhere(userId: string): Promise<void> {
    await this.users.increment({ id: userId }, 'tokenVersion', 1);
    this.sessions.revoked(userId);
  }

  private async issue(user: User): Promise<AuthResponseDto> {
    // The account's current number goes into the token (a new account's is the default, 0).
    const payload: TokenPayload = { sub: user.id, tv: user.tokenVersion ?? 0 };
    return { accessToken: await this.jwt.signAsync(payload), user: toAuthUser(user) };
  }
}

const toAuthUser = (user: User): AuthUserDto => ({
  id: user.id,
  name: user.name,
  email: user.email,
  createdAt: user.createdAt,
});
