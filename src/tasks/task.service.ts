import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Project } from '../projects/entities/project.entity.js';
import { TaskDto } from './dto/task.dto.js';
import type { UpdateTaskDto } from './dto/update-task.dto.js';
import { Task } from './entities/task.entity.js';

@Injectable()
export class TaskService {
  constructor(
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
  ) {}

  /** Flat list for a project, ordered; the frontend builds the tree from parentId. */
  findByProject(projectId: string) {
    return this.taskRepo.find({
      where: { projectId },
      order: { order: 'ASC' },
    });
  }

  async create(dto: TaskDto) {
    if (new Date(dto.endDate) < new Date(dto.startDate)) {
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
      progress: dto.progress ?? 0,
      order: dto.order ?? (await this.nextOrder(dto.projectId)),
    });
    return this.taskRepo.save(task);
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

  /** Children are kept: the FK is ON DELETE SET NULL, so they become top-level. */
  async remove(id: string) {
    const task = await this.taskRepo.findOneByOrFail({ id });
    await this.taskRepo.remove(task);
  }

  /** Move a task under a group, or pass null to make it top-level. */
  async setParent(taskId: string, parentId: string | null) {
    const task = await this.taskRepo.findOneByOrFail({ id: taskId });

    if (parentId) {
      await this.assertValidParent(task.id, task.projectId, parentId);
    }

    task.parentId = parentId;
    return this.taskRepo.save(task);
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
    return this.taskRepo.save(task);
  }

  /** Apply the fields that were sent. The dates are checked together, so moving only one end can't invert the range. */
  async update(id: string, dto: UpdateTaskDto) {
    const task = await this.taskRepo.findOneByOrFail({ id });
    Object.assign(task, dto);
    if (new Date(task.endDate) < new Date(task.startDate)) {
      throw new BadRequestException('The end date must not be before the start date');
    }
    return this.taskRepo.save(task);
  }

  /** `taskId` is null while creating: a new task has no descendants to cycle with. */
  private async assertValidParent(
    taskId: string | null,
    projectId: string | null,
    parentId: string,
  ) {
    if (parentId === taskId) {
      throw new BadRequestException('A task cannot be its own parent');
    }

    const parent = await this.taskRepo.findOneByOrFail({ id: parentId });
    if (parent.type !== 'group') {
      throw new BadRequestException('Parent must be a group');
    }
    if (parent.projectId !== projectId) {
      throw new BadRequestException('Parent belongs to another project');
    }

    if (!taskId) return;

    // The new parent must not be a descendant of this task.
    let current: Task | null = parent;
    while (current?.parentId) {
      if (current.parentId === taskId) {
        throw new BadRequestException('Moving here would create a cycle');
      }
      current = await this.taskRepo.findOneBy({ id: current.parentId });
    }
  }
}
