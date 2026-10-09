import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Project } from '../projects/entities/project.entity.js';
import { BroadcastInterceptor } from './broadcast.interceptor.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeService } from './realtime.service.js';

/** Live updates over socket.io: rooms per project, a message after each saved change (see docs/realtime.md). */
@Module({
  imports: [TypeOrmModule.forFeature([Project])],
  providers: [
    RealtimeGateway,
    RealtimeService,
    // On every route; it acts only on the ones marked @Broadcast.
    { provide: APP_INTERCEPTOR, useClass: BroadcastInterceptor },
  ],
  // The controllers send through it (see the Broadcast interceptor).
  exports: [RealtimeService],
})
export class RealtimeModule {}
