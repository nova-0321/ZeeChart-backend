import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module.js';
import { ProjectEvent } from './entities/project-event.entity.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';

@Module({
  imports: [
    // RequestTransaction: each write's one transaction.
    DatabaseModule,
    // AuthGuard (and the JwtService it needs).
    AuthModule,
    TypeOrmModule.forFeature([ProjectEvent]),
  ],
  controllers: [EventsController],
  providers: [EventsService],
  // Restoring an event from its history (revisions).
  exports: [EventsService],
})
export class EventsModule {}
