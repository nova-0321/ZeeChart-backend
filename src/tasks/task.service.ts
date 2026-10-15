import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { IsNull, type EntityManager } from 'typeorm';
import { RequestTransaction } from '../database/request-transaction.js';
import { rejectNulls } from '../common/reject-nulls.js';
import { ProjectsService } from '../projects/projects.service.js';
import { TaskDto } from './dto/task.dto.js';
import type { UpdateTaskDto } from './dto/update-task.dto.js';
import { Task } from './entities/task.entity.js';
import { groupLoop } from './group-loop.js';
import { TaskScheduler } from './scheduling/task-scheduler.service.js';

/** The day ("YYYY-MM-DD") of a date as the API takes it: what is stored is its first ten characters. */
const dayOf = (date: Date | string) =>
  typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10);

/** A place past the end of any level: the task goes last. */
const LAST = Number.MAX_SAFE_INTEGER;

/**
 * The write that numbers `level` 1, 2, 3... in its order, the rows already on their place left as
 * they are. `task` is skipped: its own save writes its order.
 */
function numberedAs(level: Task[], task: Task) {
  return async (manager: EntityManager) => {
    for (const [index, row] of level.entries()) {
      if (row === task || row.order === index + 1) continue;
      await manager.update(Task, { id: row.id }, { order: index + 1 });
    }
  };
}

@Injectable()
export class TaskService {
  constructor(
    private readonly tx: RequestTransaction,
    private readonly scheduler: TaskScheduler,
    private readonly projects: ProjectsService,
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

  /** One task; 404 when there is none (other domains read tasks here). */
  findOne(id: string): Promise<Task> {
    return this.taskRepo.findOneByOrFail({ id });
  }

  /**
   * Whether `taskId` is somewhere inside the group `groupId` (at any depth). A chain that comes back
   * to a task it passed (a loop already in the data) is refused: there is no right answer on it.
   */
  async isInside(taskId: string, groupId: string): Promise<boolean> {
    const seen = new Set<string>();
    let current = await this.taskRepo.findOneBy({ id: taskId });
    while (current?.parentId) {
      if (current.parentId === groupId) return true;
      if (seen.has(current.id)) throw groupLoop();
      seen.add(current.id);
      current = await this.taskRepo.findOneBy({ id: current.parentId });
    }
    return false;
  }

  // For restoring a task from its history (revisions), which reads and writes tasks here (#55).

  /** One task, or null when there is none. */
  find(id: string): Promise<Task | null> {
    return this.taskRepo.findOneBy({ id });
  }

  /** How many tasks the group holds (directly). */
  childCount(id: string): Promise<number> {
    return this.taskRepo.countBy({ parentId: id });
  }

  /**
   * Whether `parentId` is a group of the project that may hold `taskId` (not inside it). A group
   * whose chain loops (a loop already in the data) can't: the task stays where it is.
   */
  async canHold(projectId: string, parentId: string, taskId: string): Promise<boolean> {
    let node = await this.taskRepo.findOneBy({ id: parentId });
    if (!node || node.projectId !== projectId || node.type !== 'group') return false;
    const seen = new Set<string>();
    while (node) {
      if (node.id === taskId || seen.has(node.id)) return false;
      seen.add(node.id);
      node = node.parentId ? await this.taskRepo.findOneBy({ id: node.parentId }) : null;
    }
    return true;
  }

  /**
   * A deleted task made again with its own id (so its history goes on), at the place it had in its
   * level (`order`), the others numbered around it. In a group, the group has to cover it (and a
   * link may forbid it): the scheduler does both, as for a new task.
   */
  async recreate(
    fields: Partial<Task> & Pick<Task, 'id' | 'projectId' | 'parentId'>,
  ): Promise<Task> {
    const task = this.taskRepo.create(fields);
    const numberLevel = await this.placeIn(task, task.parentId, (fields.order ?? LAST) - 1);
    return this.saveInLevel(task, numberLevel);
  }

  async create(dto: TaskDto) {
    if (dayOf(dto.endDate) < dayOf(dto.startDate)) {
      throw new BadRequestException('The end date must not be before the start date');
    }
    // The foreign key would reject a missing project too, but only with a vague 409.
    if (!(await this.projects.exists(dto.projectId))) {
      throw new NotFoundException('Project not found');
    }
    if (dto.parentId) {
      await this.assertValidParent(null, dto.projectId, dto.parentId);
    }
    // progress has no database default, so it must be set here: without it the insert fails with
    // "null value in column ... violates not-null constraint". order is set by placeIn.
    const task = this.taskRepo.create({
      ...dto,
      parentId: dto.parentId ?? null,
      // A milestone is one day: it has no end of its own.
      ...(dto.type === 'milestone' ? { endDate: dto.startDate } : {}),
      progress: dto.progress ?? 0,
    });
    // `order` is its place in its level (1 first), the others moved down; none: the last.
    const numberLevel = await this.placeIn(task, task.parentId, (dto.order ?? LAST) - 1);
    return this.saveInLevel(task, numberLevel);
  }

  /**
   * Saves a task with the write that numbers its level (placeIn), in one transaction. In a group,
   * the group has to cover the task (and a link may forbid it): the scheduler does both.
   */
  private saveInLevel(task: Task, numberLevel: (manager: EntityManager) => Promise<void>) {
    return task.parentId
      ? this.scheduler.saveAttached(task, null, numberLevel)
      : this.taskRepo.manager.transaction(async (manager) => {
          await numberLevel(manager);
          return manager.save(Task, task);
        });
  }

  /**
   * Puts `task` at `index` (0 first; past the end: last) among the tasks of `parentId` (null: the
   * top level) as they are now: sets its `order`, and returns the write that numbers the others
   * 1, 2, 3... around it, to run in the transaction that saves it. Every level is kept numbered so
   * (#57): no gap, no two on one place.
   */
  private async placeIn(task: Task, parentId: string | null, index: number) {
    const siblings = await this.taskRepo.find({
      where: { projectId: task.projectId, parentId: parentId ?? IsNull() },
      order: { order: 'ASC', createdAt: 'ASC', id: 'ASC' },
    });
    const level = siblings.filter((sibling) => sibling.id !== task.id);
    level.splice(Math.min(Math.max(index, 0), level.length), 0, task);
    task.order = level.indexOf(task) + 1;
    return numberedAs(level, task);
  }

  /** The write that numbers the level `task` leaves (its group now) 1, 2, 3... without it. */
  private async leaveLevel(task: Task) {
    const siblings = await this.taskRepo.find({
      where: { projectId: task.projectId, parentId: task.parentId ?? IsNull() },
      order: { order: 'ASC', createdAt: 'ASC', id: 'ASC' },
    });
    return numberedAs(
      siblings.filter((sibling) => sibling.id !== task.id),
      task,
    );
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
      // The list it was in, numbered 1, 2, 3... again: its tasks where it was, and no gap.
      const level = await manager.find(Task, {
        where: { projectId, parentId: parentId ?? IsNull() },
        order: { order: 'ASC', createdAt: 'ASC', id: 'ASC' },
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
      // The group the task was in fits what is in it now.
      if (parentId) await this.scheduler.settle(manager, projectId, [parentId], []);
    });
  }

  /**
   * Puts a task in a group, or at the top level (null), at `index` there (past the end: last); the
   * level it left closes up. For restoring a task's group; the routes move tasks with `move`.
   */
  async setParent(taskId: string, parentId: string | null, index = LAST) {
    const task = await this.taskRepo.findOneByOrFail({ id: taskId });

    if (parentId) {
      await this.assertValidParent(task.id, task.projectId, parentId);
    }

    const oldParentId = task.parentId;
    const numberOld = oldParentId !== parentId ? await this.leaveLevel(task) : null;
    const numberNew = await this.placeIn(task, parentId, index);
    const numberBoth = async (manager: EntityManager) => {
      await numberOld?.(manager);
      await numberNew(manager);
    };
    task.parentId = parentId;
    // Both the group it goes in and the group it left have to fit what is in them now.
    return parentId || oldParentId
      ? this.scheduler.saveAttached(task, oldParentId, numberBoth)
      : this.taskRepo.manager.transaction(async (manager) => {
          await numberBoth(manager);
          return manager.save(Task, task);
        });
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
    const oldParentId = task.parentId;
    // Out of a group: the level it leaves closes up (no gap where it was).
    const numberOld = parentId !== oldParentId ? await this.leaveLevel(task) : null;
    const numberNew = await this.placeIn(task, parentId, index);
    const renumber = async (manager: EntityManager) => {
      if (becomesGroup) await manager.update(Task, { id: becomesGroup.id }, { type: 'group' });
      await numberOld?.(manager);
      await numberNew(manager);
    };

    task.parentId = parentId;
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
