import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { SchedulingModule } from '../scheduling/scheduling.module.js';
import { Task } from '../tasks/entities/task.entity.js';
import { DependencyController } from './dependency.controller.js';
import { DependencyService } from './dependency.service.js';
import { TaskDependency } from './entities/task-dependency.entity.js';

/** Links between tasks (FS / SS / FF / SF, with a lag). A new link can move tasks: scheduling. */
@Module({
  imports: [
    // AuthGuard (and the JwtService it needs).
    AuthModule,
    TypeOrmModule.forFeature([TaskDependency, Task]),
    SchedulingModule,
  ],
  controllers: [DependencyController],
  providers: [DependencyService],
})
export class DependenciesModule {}
