import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TaskDependency } from '../dependencies/entities/task-dependency.entity.js';
import { Task } from '../tasks/entities/task.entity.js';
import { TaskScheduler } from './task-scheduler.service.js';

/**
 * The scheduling engine: groups that fit their tasks, successors pushed by their links.
 * `schedule.ts` is the pure engine (no Nest, no database); TaskScheduler loads a project's tasks
 * and links, runs it, and saves what moved. Tasks and dependencies use it; it uses neither of
 * their services, only their entities (the rows it reads and writes).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Task, TaskDependency])],
  providers: [TaskScheduler],
  exports: [TaskScheduler],
})
export class SchedulingModule {}
