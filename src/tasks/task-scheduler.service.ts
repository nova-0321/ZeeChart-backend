import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  planEdit,
  planReschedule,
  ScheduleError,
  type DatedChange,
  type ScheduleLink,
} from './schedule.js';
import { TaskDependency } from './entities/task-dependency.entity.js';
import { Task } from './entities/task.entity.js';

const day = (date: Date | string) => String(date).slice(0, 10);

/** Applies the scheduling rules of dependencies (see schedule.ts) to the stored tasks. */
@Injectable()
export class TaskScheduler {
  constructor(
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
  ) {}

  /**
   * Save a task whose dates were just edited (`task` carries the new ones, nothing is stored yet):
   * the task (and, for a group, its tasks) moves, and so do the tasks that have to follow it, all
   * or nothing. A move stops at the earliest day that keeps its links, so the saved dates can differ
   * from the ones asked for. Returns the saved task.
   */
  async applyDateEdit(task: Task): Promise<Task> {
    return this.taskRepo.manager.transaction(async (manager) => {
      const { tasks, links } = await this.load(task.projectId, manager);
      let changes: Map<string, DatedChange>;
      try {
        changes = planEdit(tasks, links, task.id, day(task.startDate), day(task.endDate));
      } catch (error) {
        if (error instanceof ScheduleError) throw new BadRequestException(error.message);
        throw error;
      }
      const own = changes.get(task.id);
      if (own) Object.assign(task, own);
      const saved = await manager.save(Task, task);
      await this.saveChanges(manager, changes, task.id);
      return saved;
    });
  }

  /**
   * Check, before anything is stored, that the schedule can hold `link` (a new one, or the new
   * version of the one with the same `id`). A link can be impossible even without a cycle between
   * tasks: a group stretches to cover its tasks, so linking a group to a task that is pushed into
   * it can make them push each other forever. Throws a 400 saying so.
   */
  async assertSchedulable(projectId: string, link: ScheduleLink & { id?: string }) {
    const { tasks, links } = await this.load(projectId);
    const others = links.filter((other) => other.id === undefined || other.id !== link.id);
    try {
      planReschedule(tasks, [...others, link], [link.fromTaskId]);
    } catch (error) {
      if (error instanceof ScheduleError) {
        throw new BadRequestException(`That link is impossible to schedule. ${error.message}`);
      }
      throw error;
    }
  }

  /** After a link was added or changed: push the successor (and what follows) if needed. */
  async rescheduleFrom(projectId: string, fromTaskId: string) {
    await this.taskRepo.manager.transaction(async (manager) => {
      const { tasks, links } = await this.load(projectId, manager);
      await this.saveChanges(manager, planReschedule(tasks, links, [fromTaskId]));
    });
  }

  private async load(projectId: string, manager: EntityManager = this.taskRepo.manager) {
    const [taskRows, linkRows] = await Promise.all([
      manager.find(Task, { where: { projectId } }),
      manager.find(TaskDependency, { where: { projectId } }),
    ]);
    return {
      tasks: taskRows.map((row) => ({
        id: row.id,
        name: row.name,
        parentId: row.parentId,
        type: row.type,
        startDate: day(row.startDate),
        endDate: day(row.endDate),
      })),
      links: linkRows.map((row) => ({
        id: row.id,
        fromTaskId: row.fromTaskId,
        toTaskId: row.toTaskId,
        type: row.type,
        lagDays: row.lagDays,
      })),
    };
  }

  private async saveChanges(
    manager: EntityManager,
    changes: Map<string, DatedChange>,
    skipId?: string,
  ) {
    for (const [id, dates] of changes) {
      if (id === skipId) continue;
      await manager.update(Task, { id }, dates);
    }
  }
}
