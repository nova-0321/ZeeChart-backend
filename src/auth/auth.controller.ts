import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ThrottleByEmail } from '../common/throttling.js';
import { NoBroadcast } from '../realtime/broadcast.decorator.js';
import { AuthGuard, type AuthedRequest } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { AuthResponseDto, AuthUserDto } from './dto/auth-response.dto.js';
import { SignInDto } from './dto/sign-in.dto.js';
import { SignUpDto } from './dto/sign-up.dto.js';

// Signing out of one device has no endpoint: the token lives in the app, which forgets it. A token
// stays valid until it expires (JWT_EXPIRES_IN), or until the account signs out everywhere.
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Make an account and sign in. 409 when the email already has one. */
  @Post('signup')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @NoBroadcast('changes no project')
  signUp(@Body() dto: SignUpDto): Promise<AuthResponseDto> {
    return this.auth.signUp(dto);
  }

  /** Sign in. 401 for a wrong email or password (the same message for both). */
  @Post('signin')
  // Guessing passwords: a few tries a minute per address, and a few per email from anywhere.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ThrottleByEmail()
  @NoBroadcast('changes nothing')
  @HttpCode(HttpStatus.OK)
  signIn(@Body() dto: SignInDto): Promise<AuthResponseDto> {
    return this.auth.signIn(dto);
  }

  /**
   * Sign out of every device: all tokens made so far stop working (this one too), and the account's
   * open live connections are closed. 204. Signing in again makes a new token.
   */
  @Post('signout-all')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @NoBroadcast('changes no project')
  signOutEverywhere(@Req() request: AuthedRequest): Promise<void> {
    return this.auth.signOutEverywhere(request.userId);
  }

  /** The signed-in user. 401 without a valid token, or when the account no longer exists. */
  @Get('me')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  me(@Req() request: AuthedRequest): Promise<AuthUserDto> {
    return this.auth.me(request.userId);
  }
}
