import { BadRequestException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { RequestTransaction } from '../database/request-transaction.js';
import {
  planAttach,
  planEdit,
  planRefit,
  planSettle,
  planReschedule,
  ScheduleError,
  type DatedChange,
  type ScheduleLink,
} from './schedule.js';
import { TaskDependency } from '../dependencies/entities/task-dependency.entity.js';
import { Task } from '../tasks/entities/task.entity.js';

const day = (date: Date | string) => String(date).slice(0, 10);

/** Applies the scheduling rules of dependencies (see schedule.ts) to the stored tasks. */
@Injectable()
export class TaskScheduler {
  constructor(private readonly tx: RequestTransaction) {}

  private get taskRepo() {
    return this.tx.repo(Task);
  }

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
   * Save a task that was created in a group or moved into one (`task` already has its parent):
   * the groups above stretch to cover it and what follows them is pushed, all or nothing. Refused
   * when a link ties it to a group above it. Returns the saved task.
   */
  async saveAttached(
    task: Task,
    oldParentId: string | null = null,
    /** More to save in the same transaction (the new order of a level). */
    also?: (manager: EntityManager) => Promise<void>,
  ): Promise<Task> {
    return this.taskRepo.manager.transaction(async (manager) => {
      if (also) await also(manager);
      const saved = await manager.save(Task, task);
      const { tasks, links } = await this.load(saved.projectId, manager);
      try {
        await this.saveChanges(manager, planAttach(tasks, links, saved.id, oldParentId));
      } catch (error) {
        if (error instanceof ScheduleError) throw new BadRequestException(error.message);
        throw error;
      }
      return saved;
    });
  }

  /**
   * After a task left a group (it was deleted, or made top-level), fit the group, and the groups
   * above it, to the tasks that are still in them.
   */
  async refitGroup(projectId: string, groupId: string): Promise<void> {
    await this.taskRepo.manager.transaction(async (manager) => {
      const { tasks, links } = await this.load(projectId, manager);
      try {
        await this.saveChanges(manager, planRefit(tasks, links, groupId));
      } catch (error) {
        if (error instanceof ScheduleError) throw new BadRequestException(error.message);
        throw error;
      }
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

  /**
   * After rows were written back as they once were (an undo or redo), inside the caller's
   * transaction so it is all or nothing with what it wrote: each listed group fits its tasks
   * again, and links are kept around the written tasks: what follows them is pushed, and so are they
   * when a link into one (added since) needs it (see planSettle). A 400 when they can't all be kept.
   */
  async settle(
    manager: EntityManager,
    projectId: string,
    groupIds: Iterable<string>,
    writtenTaskIds: Iterable<string>,
  ): Promise<void> {
    const { tasks, links } = await this.load(projectId, manager);
    try {
      await this.saveChanges(manager, planSettle(tasks, links, groupIds, writtenTaskIds));
    } catch (error) {
      if (error instanceof ScheduleError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  private async load(projectId: string, manager: EntityManager = this.taskRepo.manager) {
    // One after the other: in a transaction both use its one connection (see loadSnapshot).
    const taskRows = await manager.find(Task, { where: { projectId } });
    const linkRows = await manager.find(TaskDependency, { where: { projectId } });
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
