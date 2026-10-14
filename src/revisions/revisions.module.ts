import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DependenciesModule } from '../dependencies/dependencies.module.js';
import { ProjectEvent } from '../events/entities/project-event.entity.js';
import { EventsModule } from '../events/events.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { SchedulingModule } from '../scheduling/scheduling.module.js';
import { Task } from '../tasks/entities/task.entity.js';
import { TaskModule } from '../tasks/task.module.js';
import { ProjectVersion } from './entities/project-version.entity.js';
import { Revision } from './entities/revision.entity.js';
import { RevisionInterceptor } from './revision.interceptor.js';
import { ProjectRevisionsController, RevisionsController } from './revisions.controller.js';
import { RevisionsService } from './revisions.service.js';
import { ProjectVersionsController, VersionsController } from './versions.controller.js';
import { VersionsService } from './versions.service.js';
import { UndoController } from './undo.controller.js';
import { UndoService } from './undo.service.js';

/** Each project's history and saved versions, restoring from them, and undo / redo (#19). */
@Module({
  imports: [
    // AuthGuard (and the JwtService it needs).
    AuthModule,
    // RequestTransaction and ProjectWriteLock, for the interceptor.
    DatabaseModule,
    TypeOrmModule.forFeature([Revision, ProjectVersion, Task, ProjectEvent]),
    // A restore goes through the same services as any change.
    TaskModule,
    EventsModule,
    ProjectsModule,
    DependenciesModule,
    SchedulingModule,
  ],
  controllers: [
    ProjectRevisionsController,
    RevisionsController,
    ProjectVersionsController,
    VersionsController,
    UndoController,
  ],
  providers: [
    RevisionsService,
    VersionsService,
    UndoService,
    // On every route; it acts only on the write routes of a project (see the interceptor).
    { provide: APP_INTERCEPTOR, useClass: RevisionInterceptor },
  ],
})
export class RevisionsModule {}
