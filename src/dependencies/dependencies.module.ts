import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SchedulingModule } from '../tasks/scheduling/scheduling.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { DependenciesController } from './dependencies.controller.js';
import { DependenciesService } from './dependencies.service.js';
import { TaskDependency } from './entities/task-dependency.entity.js';

/** Links between tasks (FS / SS / FF / SF, with a lag). A new link can move tasks: scheduling. */
@Module({
  imports: [
    // RequestTransaction: each write's one transaction.
    DatabaseModule,
    // AuthGuard (and the JwtService it needs).
    AuthModule,
    TypeOrmModule.forFeature([TaskDependency]),
    SchedulingModule,
    // The linked tasks are read through TasksService.
    TasksModule,
  ],
  controllers: [DependenciesController],
  providers: [DependenciesService],
  // Restoring a deleted task brings its links back through the same rules (revisions).
  exports: [DependenciesService],
})
export class DependenciesModule {}
