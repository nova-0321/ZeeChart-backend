import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SchedulingModule } from '../tasks/scheduling/scheduling.module.js';
import { TaskModule } from '../tasks/task.module.js';
import { DependencyController } from './dependency.controller.js';
import { DependencyService } from './dependency.service.js';
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
    // The linked tasks are read through TaskService.
    TaskModule,
  ],
  controllers: [DependencyController],
  providers: [DependencyService],
  // Restoring a deleted task brings its links back through the same rules (revisions).
  exports: [DependencyService],
})
export class DependenciesModule {}
