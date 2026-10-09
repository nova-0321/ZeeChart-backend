import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import type { AuthResponseDto, AuthUserDto } from './dto/auth-response.dto.js';
import type { SignInDto } from './dto/sign-in.dto.js';
import type { SignUpDto } from './dto/sign-up.dto.js';
import { User } from './entities/user.entity.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password.js';

/** What a token carries: the user's id in `sub`. */
export interface TokenPayload {
  sub: string;
}

const EMAIL_TAKEN = 'An account with this email already exists';
// One message for a wrong email and a wrong password: the answer does not tell which emails
// have accounts.
const BAD_CREDENTIALS = 'The email or password is incorrect';

const isUniqueViolation = (error: unknown) =>
  error instanceof QueryFailedError && (error.driverError as { code?: string }).code === '23505';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly jwt: JwtService,
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
      select: { id: true, name: true, email: true, createdAt: true, passwordHash: true },
    });
    // An unknown email still costs one hash check (see dummyPasswordHash).
    const ok = await verifyPassword(
      dto.password,
      user?.passwordHash ?? (await dummyPasswordHash()),
    );
    if (!user || !ok) throw new UnauthorizedException(BAD_CREDENTIALS);
    return this.issue(user);
  }

  async me(id: string): Promise<AuthUserDto> {
    const user = await this.users.findOneBy({ id });
    // The token is valid but its account is gone: the same as an ended session.
    if (!user) throw new UnauthorizedException('The account no longer exists. Sign in again');
    return toAuthUser(user);
  }

  private async issue(user: User): Promise<AuthResponseDto> {
    const payload: TokenPayload = { sub: user.id };
    return { accessToken: await this.jwt.signAsync(payload), user: toAuthUser(user) };
  }
}

const toAuthUser = (user: User): AuthUserDto => ({
  id: user.id,
  name: user.name,
  email: user.email,
  createdAt: user.createdAt,
});
