import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { SchedulingModule } from '../scheduling/scheduling.module.js';
import { Task } from '../tasks/entities/task.entity.js';
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
    TypeOrmModule.forFeature([TaskDependency, Task]),
    SchedulingModule,
  ],
  controllers: [DependencyController],
  providers: [DependencyService],
  // Restoring a deleted task brings its links back through the same rules (revisions).
  exports: [DependencyService],
})
export class DependenciesModule {}
