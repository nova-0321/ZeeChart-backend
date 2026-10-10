import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectsService } from './projects.service.js';
import { ProjectsController } from './projects.controller.js';
import { Member } from '../members/entities/member.entity.js';
import { Project } from './entities/project.entity.js';

@Module({
  imports: [
    // AuthGuard (and the JwtService it needs).
    AuthModule,
    TypeOrmModule.forFeature([Project, Member]),
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
