import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module.js';
import { BroadcastInterceptor } from './broadcast.interceptor.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeService } from './realtime.service.js';

/** Live updates over socket.io: rooms per project, a message after each saved change (see docs/realtime.md). */
@Module({
  imports: [
    // The JwtService that checks the token a socket connects with.
    AuthModule,
  ],
  providers: [
    RealtimeGateway,
    RealtimeService,
    // On every route; it acts only on the ones marked @Broadcast.
    { provide: APP_INTERCEPTOR, useClass: BroadcastInterceptor },
  ],
  // The controllers send through it (see the Broadcast interceptor), and members through it.
  exports: [RealtimeService],
})
export class RealtimeModule {}
