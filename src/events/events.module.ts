import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectEvent } from './entities/project-event.entity.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([ProjectEvent])],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
