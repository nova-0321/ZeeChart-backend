import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { User } from './entities/user.entity.js';
import { SessionEvents } from './token.js';

/** Accounts and sign-in (#31): sign up, sign in, and who is signed in. */
@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        // Checked at startup to look like 7d / 12h (see env.validation.ts).
        signOptions: {
          expiresIn: (config.get<string>('JWT_EXPIRES_IN') ?? '7d') as JwtSignOptions['expiresIn'],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthGuard, SessionEvents],
  // Other modules protect their routes with the same guard; the live connection hears of sign-ins
  // that were ended (SessionEvents); other domains read accounts through AuthService.
  exports: [AuthGuard, JwtModule, SessionEvents, AuthService],
})
export class AuthModule {}
