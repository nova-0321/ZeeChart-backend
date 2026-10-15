import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { SchedulingModule } from './scheduling/scheduling.module.js';
import { Task } from './entities/task.entity.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

/** Tasks: create, edit, move, regroup, delete. Date changes go through scheduling. */
@Module({
  imports: [
    // RequestTransaction: each write's one transaction.
    DatabaseModule,
    // AuthGuard (and the JwtService it needs).
    AuthModule,
    TypeOrmModule.forFeature([Task]),
    SchedulingModule,
    // Whether a task's project exists (ProjectsService).
    ProjectsModule,
  ],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
