import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DependencyController } from './dependency.controller.js';
import { DependencyService } from './dependency.service.js';
import { TaskController } from './task.controller.js';
import { TaskDependency } from './entities/task-dependency.entity.js';
import { Task } from './entities/task.entity.js';
import { TaskScheduler } from './task-scheduler.service.js';
import { TaskService } from './task.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Task, TaskDependency])],
  controllers: [TaskController, DependencyController],
  providers: [TaskService, DependencyService, TaskScheduler],
  exports: [TaskService],
})
export class TaskModule {}
