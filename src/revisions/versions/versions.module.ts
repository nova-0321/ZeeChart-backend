import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { ProjectsModule } from '../../projects/projects.module.js';
import { ProjectVersion } from '../entities/project-version.entity.js';
import { ProjectVersionsController, VersionsController } from './versions.controller.js';
import { VersionsService } from './versions.service.js';

/** Saved versions of a whole project: saved as it changes or by hand, restored, copied (#19). */
@Module({
  imports: [
    // AuthGuard (and the JwtService it needs).
    AuthModule,
    // RequestTransaction: each write's one transaction.
    DatabaseModule,
    TypeOrmModule.forFeature([ProjectVersion]),
    // A copy is a new project.
    ProjectsModule,
  ],
  controllers: [ProjectVersionsController, VersionsController],
  providers: [VersionsService],
  // RevisionInterceptor saves a version after a change here.
  exports: [VersionsService],
})
export class VersionsModule {}
