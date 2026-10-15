import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module.js';
import { ProjectsService } from './projects.service.js';
import { ProjectsController } from './projects.controller.js';
import { Project } from './entities/project.entity.js';

@Module({
  imports: [
    // RequestTransaction: each write's one transaction.
    DatabaseModule,
    // AuthGuard (and the JwtService it needs).
    AuthModule,
    TypeOrmModule.forFeature([Project]),
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
