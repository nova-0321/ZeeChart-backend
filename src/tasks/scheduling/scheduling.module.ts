import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../../database/database.module.js';
import { Task } from '../entities/task.entity.js';
import { TaskScheduler } from './task-scheduler.service.js';

/**
 * The scheduling engine: groups that fit their tasks, successors pushed by their links.
 * `schedule.ts` is the pure engine (no Nest, no database); TaskScheduler loads a project's tasks
 * and links, runs it, and saves what moved. Part of the tasks domain (it writes tasks); it reads
 * the links through the dependencies domain (link-rows.ts). Tasks and dependencies use it.
 */
@Module({
  imports: [DatabaseModule, TypeOrmModule.forFeature([Task])],
  providers: [TaskScheduler],
  exports: [TaskScheduler],
})
export class SchedulingModule {}
