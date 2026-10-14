import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { IsNull, type EntityManager } from 'typeorm';
import { RequestTransaction } from '../database/request-transaction.js';
import { rejectNulls } from '../common/reject-nulls.js';
import { Project } from '../projects/entities/project.entity.js';
import { TaskDto } from './dto/task.dto.js';
import type { UpdateTaskDto } from './dto/update-task.dto.js';
import { Task } from './entities/task.entity.js';
import { groupLoop } from './group-loop.js';
import { TaskScheduler } from '../scheduling/task-scheduler.service.js';

/** The day ("YYYY-MM-DD") of a date as the API takes it: what is stored is its first ten characters. */
const dayOf = (date: Date | string) =>
  typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10);

@Injectable()
export class TaskService {
  constructor(
    private readonly tx: RequestTransaction,
    private readonly scheduler: TaskScheduler,
  ) {}

  private get taskRepo() {
    return this.tx.repo(Task);
  }

  /** Flat list for a project, ordered; the frontend builds the tree from parentId. */
  findByProject(projectId: string) {
    return this.taskRepo.find({
      where: { projectId },
      // Tasks with the same order (made at the same moment) keep a fixed place.
      order: { order: 'ASC', createdAt: 'ASC', id: 'ASC' },
    });
  }

  async create(dto: TaskDto) {
    if (dayOf(dto.endDate) < dayOf(dto.startDate)) {
      throw new BadRequestException('The end date must not be before the start date');
    }
    // The foreign key would reject a missing project too, but only with a vague 409.
    const projectExists = await this.taskRepo.manager.exists(Project, {
      where: { id: dto.projectId },
    });
    if (!projectExists) throw new NotFoundException('Project not found');
    if (dto.parentId) {
      await this.assertValidParent(null, dto.projectId, dto.parentId);
    }
    // progress and order have no database default, so they must be set here: without them the
    // insert fails with "null value in column ... violates not-null constraint".
    const task = this.taskRepo.create({
      ...dto,
      // A milestone is one day: it has no end of its own.
      ...(dto.type === 'milestone' ? { endDate: dto.startDate } : {}),
      progress: dto.progress ?? 0,
      order: dto.order ?? (await this.nextOrder(dto.projectId)),
    });
    // In a group, the group has to cover the task (and a link may forbid it): the scheduler does both.
    return task.parentId ? this.scheduler.saveAttached(task) : this.taskRepo.save(task);
  }

  /** One past the highest order in the project, so a new task goes to the end of the list. */
  private async nextOrder(projectId: string) {
    const row = await this.taskRepo
      .createQueryBuilder('task')
      .select('MAX(task.order)', 'max')
      .where('task.projectId = :projectId', { projectId })
      .getRawOne<{ max: number | null }>();
    return (row?.max ?? 0) + 1;
  }

  /**
   * A deleted group's tasks are kept: they go up into the list it was in (the group above it, or the
   * top level), taking its place there. All in one transaction with the refit of the group it was
   * in, which keeps those tasks too: all of it, or none.
   */
  async remove(id: string) {
    const task = await this.taskRepo.findOneByOrFail({ id });
    const { parentId, projectId } = task;
    await this.taskRepo.manager.transaction(async (manager) => {
      const children = await manager.find(Task, {
        where: { parentId: id },
        order: { order: 'ASC', createdAt: 'ASC' },
      });
      // Up a level first (the FK would only make them top-level).
      if (children.length > 0) await manager.update(Task, { parentId: id }, { parentId });
      await manager.delete(Task, { id });
      if (children.length > 0) {
        const level = await manager.find(Task, {
          where: { projectId, parentId: parentId ?? IsNull() },
          order: { order: 'ASC', createdAt: 'ASC' },
        });
        const moved = new Set(children.map((child) => child.id));
        const others = level.filter((row) => !moved.has(row.id));
        // Where the group was in that list.
        const at = others.filter((row) => row.order < task.order).length;
        const placed = [...others.slice(0, at), ...children, ...others.slice(at)];
        for (const [index, row] of placed.entries()) {
          if (row.order !== index + 1) {
            await manager.update(Task, { id: row.id }, { order: index + 1 });
          }
        }
      }
      // The group the task was in fits what is in it now.
      if (parentId) await this.scheduler.settle(manager, projectId, [parentId], []);
    });
  }

  /** Move a task under a group, or pass null to make it top-level. */
  async setParent(taskId: string, parentId: string | null) {
    const task = await this.taskRepo.findOneByOrFail({ id: taskId });

    if (parentId) {
      await this.assertValidParent(task.id, task.projectId, parentId);
    }

    const oldParentId = task.parentId;
    task.parentId = parentId;
    // Both the group it goes in and the group it left have to fit what is in them now.
    return parentId || oldParentId
      ? this.scheduler.saveAttached(task, oldParentId)
      : this.taskRepo.save(task);
  }

  /**
   * Put the task at `index` among the tasks of `parentId` (null: the top level). Those tasks are
   * numbered 1, 2, 3... in their new order; the tree is built per group, so only the order inside a
   * level matters. A change of group goes through the scheduler like setParent (the group it goes
   * in and the one it left fit what is in them), and all of it is one transaction. A plain task as
   * the parent becomes a group (and so takes the days of what it holds).
   */
  async move(taskId: string, parentId: string | null, index: number) {
    const task = await this.taskRepo.findOneByOrFail({ id: taskId });
    // Dropped onto a plain task: that task becomes a group holding it (in the same transaction).
    const parent = parentId
      ? await this.assertValidParent(task.id, task.projectId, parentId, true)
      : null;
    const becomesGroup = parent?.type === 'task' ? parent : null;
    const siblings = await this.taskRepo.find({
      where: { projectId: task.projectId, parentId: parentId ?? IsNull() },
      order: { order: 'ASC', createdAt: 'ASC', id: 'ASC' },
    });
    const level = siblings.filter((sibling) => sibling.id !== task.id);
    level.splice(Math.min(index, level.length), 0, task);
    const orderOf = new Map(level.map((item, position) => [item.id, position + 1]));
    const renumber = async (manager: EntityManager) => {
      if (becomesGroup) await manager.update(Task, { id: becomesGroup.id }, { type: 'group' });
      for (const sibling of level) {
        if (sibling.id === task.id || sibling.order === orderOf.get(sibling.id)) continue;
        await manager.update(Task, { id: sibling.id }, { order: orderOf.get(sibling.id) });
      }
    };

    const oldParentId = task.parentId;
    task.parentId = parentId;
    task.order = orderOf.get(task.id)!;
    if (parentId !== oldParentId) {
      return this.scheduler.saveAttached(task, oldParentId, renumber);
    }
    return this.taskRepo.manager.transaction(async (manager) => {
      await renumber(manager);
      return manager.save(Task, task);
    });
  }

  async changeType(id: string, type: Task['type']) {
    const task = await this.taskRepo.findOneByOrFail({ id });

    if (task.type === 'group' && type !== 'group') {
      const childCount = await this.taskRepo.countBy({ parentId: id });
      if (childCount > 0) {
        throw new BadRequestException(
          'Move or delete the child tasks before changing the type of a group',
        );
      }
    }

    task.type = type;
    if (type === 'milestone' && dayOf(task.endDate) !== dayOf(task.startDate)) {
      // A milestone is one day: its end moves to its start, which can shrink its group and move
      // what is linked to it, as any date edit (the scheduler keeps those rules).
      task.endDate = task.startDate;
      return this.scheduler.applyDateEdit(task);
    }
    return this.taskRepo.save(task);
  }

  /**
   * Apply the fields that were sent. The dates are checked together, so moving only one end can't
   * invert the range. New dates also move what the dependencies tie to this task (see schedule.ts).
   */
  async update(id: string, dto: UpdateTaskDto) {
    rejectNulls(dto, ['description']);
    const task = await this.taskRepo.findOneByOrFail({ id });
    const before = {
      start: String(task.startDate).slice(0, 10),
      end: String(task.endDate).slice(0, 10),
    };
    Object.assign(task, dto);
    if (dayOf(task.endDate) < dayOf(task.startDate)) {
      throw new BadRequestException('The end date must not be before the start date');
    }
    if (task.type === 'milestone') task.endDate = task.startDate;
    const moved =
      String(task.startDate).slice(0, 10) !== before.start ||
      String(task.endDate).slice(0, 10) !== before.end;
    return moved ? this.scheduler.applyDateEdit(task) : this.taskRepo.save(task);
  }

  /** `taskId` is null while creating: a new task has no descendants to cycle with. */
  /**
   * Checks a new parent and returns it. `taskMayBecomeGroup`: a plain task is accepted too (the
   * caller turns it into a group); a milestone never holds tasks.
   */
  private async assertValidParent(
    taskId: string | null,
    projectId: string | null,
    parentId: string,
    taskMayBecomeGroup = false,
  ): Promise<Task> {
    if (parentId === taskId) {
      throw new BadRequestException('A task cannot be its own parent');
    }

    const parent = await this.taskRepo.findOneByOrFail({ id: parentId });
    if (parent.type !== 'group' && !(taskMayBecomeGroup && parent.type === 'task')) {
      throw new BadRequestException(
        parent.type === 'milestone' ? 'A milestone cannot hold tasks' : 'Parent must be a group',
      );
    }
    if (parent.projectId !== projectId) {
      throw new BadRequestException('Parent belongs to another project');
    }

    if (!taskId) return parent;

    // The new parent must not be a descendant of this task. A chain that comes back to a task it
    // passed (a loop already in the data) is refused, not followed forever.
    const seen = new Set<string>();
    let current: Task | null = parent;
    while (current?.parentId) {
      if (current.parentId === taskId) {
        throw new BadRequestException('Moving here would create a cycle');
      }
      if (seen.has(current.id)) throw groupLoop();
      seen.add(current.id);
      current = await this.taskRepo.findOneBy({ id: current.parentId });
    }
    return parent;
  }
}
