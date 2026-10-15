import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RequestTransaction } from '../../database/request-transaction.js';
import { DependencyService } from '../../dependencies/dependency.service.js';
import { EventsService } from '../../events/events.service.js';
import { roleIn } from '../../members/membership.js';
import { ProjectsService } from '../../projects/projects.service.js';
import { TaskService } from '../../tasks/task.service.js';
import { Revision } from '../entities/revision.entity.js';
import type { RestoreResultDto as RestoreResult } from './dto/restore-result.dto.js';
import { type EventState, type ProjectState, stateOf, type TaskState } from './revision-diff.js';

/** A task's type, as TaskService takes it. */
type TaskType = Parameters<TaskService['changeType']>[1];

/**
 * Restoring a task, an event or the project from one revision of its history. It goes through the
 * same services as any change, so the same rules hold (groups cover their tasks, links push tasks),
 * and is itself recorded as a change (RevisionInterceptor). Apart from RevisionsService (#59): this
 * is what needs the other domains' services.
 */
@Injectable()
export class RestoreService {
  constructor(
    private readonly tx: RequestTransaction,
    private readonly tasks: TaskService,
    private readonly events: EventsService,
    private readonly projects: ProjectsService,
    private readonly links: DependencyService,
  ) {}

  private get revisionRepo() {
    return this.tx.repo(Revision);
  }

  /**
   * Puts an entity back the way it was right after the revision (for a deletion: right before it,
   * so it comes back). A project's own revisions are its owners' to restore. 400 when the state
   * can't be put back as it stands now (see the messages); then nothing of it is put back.
   */
  restore(id: string, userId: string): Promise<RestoreResult> {
    return this.tx.run(() => this.restoreNow(id, userId));
  }

  private async restoreNow(id: string, userId: string): Promise<RestoreResult> {
    const revision = await this.revisionRepo.findOneBy({ id });
    if (!revision) throw new NotFoundException('Not found');
    const state = stateOf(revision);
    if (!state) throw new BadRequestException('This revision has nothing to restore');
    const result: RestoreResult = {
      entityType: revision.entityType,
      entityId: revision.entityId,
      version: revision.version,
      skipped: [],
    };
    switch (revision.entityType) {
      case 'task':
        await this.restoreTask(revision.projectId, state as TaskState, result.skipped);
        break;
      case 'event':
        await this.restoreEvent(revision.projectId, state as EventState);
        break;
      case 'link':
        // A link comes back with its task (restoring a deleted task), with undo, or with a version.
        throw new BadRequestException('A link is restored with its task, or with undo');
      case 'project': {
        if ((await roleIn(this.tx.manager, revision.projectId, userId)) !== 'owner') {
          throw new ForbiddenException('Only an owner of this project can do this');
        }
        const project = state as ProjectState;
        await this.projects.update(
          revision.projectId,
          {
            name: project.name,
            // null clears it (the project had none then).
            description: project.description as string | undefined,
            archived: project.archived,
          },
          userId,
        );
        break;
      }
    }
    return result;
  }

  private async restoreTask(projectId: string, state: TaskState, skipped: string[]) {
    const current = await this.tasks.find(state.id);
    // The group it was in, if it is still there to hold it (and wouldn't hold its own group).
    let parentId = state.parentId;
    if (parentId && !(await this.tasks.canHold(projectId, parentId, state.id))) {
      skipped.push(
        'its group (gone, no longer a group, or in a loop of groups): it stays where it is',
      );
      parentId = current ? current.parentId : null;
    }

    if (!current) {
      // Deleted since: made again, with the same id (so its history goes on).
      await this.tasks.recreate({
        id: state.id,
        projectId,
        name: state.name,
        description: state.description ?? undefined,
        type: state.type as TaskType,
        priority: state.priority as 'medium',
        startDate: state.startDate as unknown as Date,
        endDate: (state.type === 'milestone' ? state.startDate : state.endDate) as unknown as Date,
        progress: state.progress,
        color: state.color,
        order: state.order,
        parentId,
      });
      // Its links, where the task at the other end is still there (the same rules as a new link).
      for (const link of state.links ?? []) {
        try {
          await this.links.create({
            fromTaskId: link.fromTaskId,
            toTaskId: link.toTaskId,
            type: link.type as 'FS',
            lagDays: link.lagDays,
          });
        } catch {
          skipped.push('a link (the task at its other end is gone, or the link no longer fits)');
        }
      }
      return;
    }

    // Still there: checked first, so nothing is half put back.
    if (current.type === 'group' && state.type !== 'group') {
      if ((await this.tasks.childCount(current.id)) > 0) {
        throw new BadRequestException(
          'This group has tasks in it now. Move them out before restoring it as a task',
        );
      }
    }
    // A refused step (a link may not allow it in its group) undoes the whole restore: it is one
    // transaction, so the task stays as it was.
    if (current.parentId !== parentId) await this.tasks.setParent(current.id, parentId);
    if (current.type !== state.type) {
      await this.tasks.changeType(current.id, state.type as TaskType);
    }
    await this.tasks.update(current.id, {
      name: state.name,
      // null clears it (it had none then).
      description: state.description as string | undefined,
      priority: state.priority as 'medium',
      progress: state.progress,
      color: state.color,
      startDate: state.startDate as unknown as Date,
      endDate: state.endDate as unknown as Date,
    });
  }

  private async restoreEvent(projectId: string, state: EventState) {
    const fields = {
      name: state.name,
      color: state.color,
      startDate: state.startDate,
      endDate: state.endDate,
    };
    if (await this.events.exists(state.id)) {
      await this.events.update(state.id, fields);
    } else {
      await this.events.recreate(state.id, projectId, fields);
    }
  }
}
