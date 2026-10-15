import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { DependenciesModule } from '../../dependencies/dependencies.module.js';
import { EventsModule } from '../../events/events.module.js';
import { ProjectsModule } from '../../projects/projects.module.js';
import { TasksModule } from '../../tasks/tasks.module.js';
import { Revision } from '../entities/revision.entity.js';
import { RestoreService } from './restore.service.js';
import { ProjectRevisionsController, RevisionsController } from './revisions.controller.js';
import { RevisionsService } from './revisions.service.js';

/** A project's history: recorded, listed, let go when old, and restored from (#19). */
@Module({
  imports: [
    // AuthGuard (and the JwtService it needs).
    AuthModule,
    // RequestTransaction: each write's one transaction.
    DatabaseModule,
    TypeOrmModule.forFeature([Revision]),
    // A restore goes through the same services as any change.
    TasksModule,
    EventsModule,
    ProjectsModule,
    DependenciesModule,
  ],
  controllers: [ProjectRevisionsController, RevisionsController],
  providers: [RevisionsService, RestoreService],
  // RevisionInterceptor records every change here.
  exports: [RevisionsService],
})
export class HistoryModule {}
