import { BadRequestException, Injectable } from '@nestjs/common';
import { RequestTransaction } from '../database/request-transaction.js';
import type { DependencyDto } from './dto/dependency.dto.js';
import type { UpdateDependencyDto } from './dto/update-dependency.dto.js';
import { TaskDependency } from './entities/task-dependency.entity.js';
import { Task } from '../tasks/entities/task.entity.js';
import { groupLoop } from '../tasks/group-loop.js';
import { TaskScheduler } from '../scheduling/task-scheduler.service.js';

@Injectable()
export class DependencyService {
  constructor(
    private readonly tx: RequestTransaction,
    private readonly scheduler: TaskScheduler,
  ) {}

  private get dependencyRepo() {
    return this.tx.repo(TaskDependency);
  }

  private get taskRepo() {
    return this.tx.repo(Task);
  }

  findByProject(projectId: string) {
    return this.dependencyRepo.find({ where: { projectId }, order: { createdAt: 'ASC' } });
  }

  /**
   * Link two tasks (groups too). If the successor is already too early it is moved, with
   * everything below it and everything that follows it; the client reloads the tasks to see that.
   * One transaction: if the link can't be applied, nothing of it is saved.
   */
  create(dto: DependencyDto) {
    return this.tx.run(() => this.createNow(dto));
  }

  private async createNow(dto: DependencyDto) {
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
    await this.scheduler.rescheduleFrom(from.projectId, from.id);
    return dependency;
  }

  /**
   * Change the type and/or the lag; the successor is moved if the new rule needs it. One
   * transaction: if the new rule can't be applied, the link stays as it was.
   */
  update(id: string, dto: UpdateDependencyDto) {
    return this.tx.run(async () => {
      const dependency = await this.dependencyRepo.findOneByOrFail({ id });
      Object.assign(dependency, dto);
      await this.scheduler.assertSchedulable(dependency.projectId, dependency);
      const saved = await this.dependencyRepo.save(dependency);
      await this.scheduler.rescheduleFrom(saved.projectId, saved.fromTaskId);
      return saved;
    });
  }

  async remove(id: string) {
    const dependency = await this.dependencyRepo.findOneByOrFail({ id });
    await this.dependencyRepo.remove(dependency);
  }

  /**
   * Whether `descendantId` is somewhere below `task` in the group tree. A chain that comes back to
   * a task it passed (a loop already in the data) is refused: there is no right answer on it.
   */
  private async isAncestor(task: Task, descendantId: string) {
    const seen = new Set<string>();
    let current = await this.taskRepo.findOneBy({ id: descendantId });
    while (current?.parentId) {
      if (current.parentId === task.id) return true;
      if (seen.has(current.id)) throw groupLoop();
      seen.add(current.id);
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
