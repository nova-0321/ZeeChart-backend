import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { DependencyDto } from './dto/dependency.dto.js';
import type { UpdateDependencyDto } from './dto/update-dependency.dto.js';
import { TaskDependency } from './entities/task-dependency.entity.js';
import { Task } from '../tasks/entities/task.entity.js';
import { TaskScheduler } from '../scheduling/task-scheduler.service.js';

@Injectable()
export class DependencyService {
  constructor(
    @InjectRepository(TaskDependency)
    private readonly dependencyRepo: Repository<TaskDependency>,
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
    private readonly scheduler: TaskScheduler,
  ) {}

  findByProject(projectId: string) {
    return this.dependencyRepo.find({ where: { projectId }, order: { createdAt: 'ASC' } });
  }

  /**
   * Link two tasks (groups too). If the successor is already too early it is moved, with
   * everything below it and everything that follows it; the client reloads the tasks to see that.
   */
  async create(dto: DependencyDto) {
    if (dto.fromTaskId === dto.toTaskId) {
      throw new BadRequestException('A task cannot depend on itself');
    }
    const from = await this.taskRepo.findOneByOrFail({ id: dto.fromTaskId });
    const to = await this.taskRepo.findOneByOrFail({ id: dto.toTaskId });
    if (from.projectId !== to.projectId) {
      throw new BadRequestException('Both tasks must belong to the same project');
    }
    if ((await this.isAncestor(from, to.id)) || (await this.isAncestor(to, from.id))) {
      throw new BadRequestException('A group cannot be linked to a task inside it');
    }
    const duplicate = await this.dependencyRepo.existsBy({
      fromTaskId: from.id,
      toTaskId: to.id,
    });
    if (duplicate) throw new BadRequestException('These tasks are already linked');
    if (await this.reaches(to.id, from.id)) {
      throw new BadRequestException('That link would make the tasks wait for each other');
    }
    await this.scheduler.assertSchedulable(from.projectId, {
      fromTaskId: from.id,
      toTaskId: to.id,
      type: dto.type ?? 'FS',
      lagDays: dto.lagDays ?? 0,
    });
    const dependency = await this.dependencyRepo.save(
      this.dependencyRepo.create({
        projectId: from.projectId,
        fromTaskId: from.id,
        toTaskId: to.id,
        type: dto.type ?? 'FS',
        lagDays: dto.lagDays ?? 0,
      }),
    );
    try {
      await this.scheduler.rescheduleFrom(from.projectId, from.id);
    } catch (error) {
      // Not saved at all if it could not be applied: the client got an error, so no link may stay.
      await this.dependencyRepo.delete(dependency.id);
      throw error;
    }
    return dependency;
  }

  /** Change the type and/or the lag; the successor is moved if the new rule needs it. */
  async update(id: string, dto: UpdateDependencyDto) {
    const dependency = await this.dependencyRepo.findOneByOrFail({ id });
    const old = { type: dependency.type, lagDays: dependency.lagDays };
    Object.assign(dependency, dto);
    await this.scheduler.assertSchedulable(dependency.projectId, dependency);
    const saved = await this.dependencyRepo.save(dependency);
    try {
      await this.scheduler.rescheduleFrom(saved.projectId, saved.fromTaskId);
    } catch (error) {
      // Put the link back as it was: the client got an error, so it must not have changed.
      await this.dependencyRepo.update({ id }, old);
      throw error;
    }
    return saved;
  }

  async remove(id: string) {
    const dependency = await this.dependencyRepo.findOneByOrFail({ id });
    await this.dependencyRepo.remove(dependency);
  }

  /** Whether `descendantId` is somewhere below `task` in the group tree. */
  private async isAncestor(task: Task, descendantId: string) {
    let current = await this.taskRepo.findOneBy({ id: descendantId });
    for (let guard = 0; current?.parentId && guard < 100; guard++) {
      if (current.parentId === task.id) return true;
      current = await this.taskRepo.findOneBy({ id: current.parentId });
    }
    return false;
  }

  /** Whether `target` can be reached from `start` by following the links forward. */
  private async reaches(start: string, target: string) {
    const seen = new Set<string>([start]);
    let frontier = [start];
    while (frontier.length > 0) {
      const next = await this.dependencyRepo
        .createQueryBuilder('dependency')
        .select('dependency.toTaskId', 'id')
        .where('dependency.fromTaskId IN (:...frontier)', { frontier })
        .getRawMany<{ id: string }>();
      frontier = [];
      for (const { id } of next) {
        if (id === target) return true;
        if (!seen.has(id)) {
          seen.add(id);
          frontier.push(id);
        }
      }
    }
    return false;
  }
}
