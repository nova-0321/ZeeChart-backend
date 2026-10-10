import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { NoBroadcast } from '../realtime/broadcast.decorator.js';
import { AuthGuard, type AuthedRequest } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { AuthResponseDto, AuthUserDto } from './dto/auth-response.dto.js';
import { SignInDto } from './dto/sign-in.dto.js';
import { SignUpDto } from './dto/sign-up.dto.js';

// Sign-out has no endpoint: the token lives in the app, which forgets it. A token stays valid
// until it expires (JWT_EXPIRES_IN).
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Make an account and sign in. 409 when the email already has one. */
  @Post('signup')
  @NoBroadcast('changes no project')
  signUp(@Body() dto: SignUpDto): Promise<AuthResponseDto> {
    return this.auth.signUp(dto);
  }

  /** Sign in. 401 for a wrong email or password (the same message for both). */
  @Post('signin')
  @NoBroadcast('changes nothing')
  @HttpCode(HttpStatus.OK)
  signIn(@Body() dto: SignInDto): Promise<AuthResponseDto> {
    return this.auth.signIn(dto);
  }

  /** The signed-in user. 401 without a valid token, or when the account no longer exists. */
  @Get('me')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  me(@Req() request: AuthedRequest): Promise<AuthUserDto> {
    return this.auth.me(request.userId);
  }
}
