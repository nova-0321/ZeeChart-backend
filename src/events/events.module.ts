import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectEvent } from './entities/project-event.entity.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';

@Module({
  imports: [
    // AuthGuard (and the JwtService it needs).
    AuthModule,
    TypeOrmModule.forFeature([ProjectEvent]),
  ],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
