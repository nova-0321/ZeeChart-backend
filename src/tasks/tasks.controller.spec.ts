import {
  BadRequestException,
  NotFoundException,
  ParseUUIDPipe,
  RequestMethod,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants.js';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { DataSource } from 'typeorm';
import { AuthGuard } from '../auth/auth.guard.js';
import {
  PROJECT_ACCESS,
  ProjectAccessGuard,
  type ProjectAccessOptions,
  type ProjectLocator,
} from '../projects/project-access.js';
import { BROADCAST, type BroadcastOptions } from '../realtime/broadcast.decorator.js';
import type { CreateTaskDto } from './dto/create-task.dto.js';
import { Task } from './entities/task.entity.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

// Where @nestjs/swagger keeps a route's documented parameters, headers among them (its constants
// aren't exported).
const API_PARAMETERS = 'swagger/apiParameters';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const GROUP = '33333333-3333-4333-8333-333333333333';

type Route = keyof TasksController;
const handler = (route: Route) => TasksController.prototype[route] as object;
const access = (route: Route) =>
  Reflect.getMetadata(PROJECT_ACCESS, handler(route)) as ProjectAccessOptions | undefined;
const broadcast = (route: Route) =>
  Reflect.getMetadata(BROADCAST, handler(route)) as BroadcastOptions | undefined;
/** Whether the route takes If-Match (@IfMatch documents the header). */
const takesIfMatch = (route: Route) =>
  (
    (Reflect.getMetadata(API_PARAMETERS, handler(route)) ?? []) as { name: string; in: string }[]
  ).some((param) => param.in === 'header' && param.name === 'If-Match');

/**
 * Runs a route's project locator on a request, against a database that only answers the lookup of
 * a row's project: says which project it found, and which table and id it looked up (if any).
 */
const locate = async (
  locator: ProjectLocator,
  request: { params?: object; query?: object; body?: object },
) => {
  const seen: { entity?: unknown; id?: unknown } = {};
  const query = {
    select: () => query,
    where: (_sql: string, params: { id: string }) => {
      seen.id = params.id;
      return query;
    },
    getRawOne: () => Promise.resolve({ projectId: PROJECT }),
  };
  const db = {
    getRepository: (entity: unknown) => {
      seen.entity = entity;
      return { createQueryBuilder: () => query };
    },
  };
  const projectId = await locator(
    { params: {}, query: {}, body: {}, ...request } as unknown as Request,
    db as unknown as DataSource,
  );
  return { projectId, ...seen };
};

describe('TasksController', () => {
  let controller: TasksController;
  const service = {
    findByProject: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    move: vi.fn(),
    changeType: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TasksController],
      // The controller only delegates; the service has its own spec.
      providers: [{ provide: TasksService, useValue: service }],
    })
      // Sign-in, membership and roles are tested end to end (test/ownership.e2e-spec.ts,
      // test/members.e2e-spec.ts); here only what each route declares for them.
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ProjectAccessGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<TasksController>(TasksController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('routes', () => {
    it('every route is under /tasks, behind sign-in and the project access check', () => {
      expect(Reflect.getMetadata(PATH_METADATA, TasksController)).toBe('tasks');
      expect(Reflect.getMetadata(GUARDS_METADATA, TasksController)).toEqual([
        AuthGuard,
        ProjectAccessGuard,
      ]);
    });

    it.each<[Route, RequestMethod, string]>([
      ['findByProject', RequestMethod.GET, '/'],
      ['create', RequestMethod.POST, '/'],
      ['update', RequestMethod.PATCH, ':id'],
      ['remove', RequestMethod.DELETE, ':id'],
      ['move', RequestMethod.PATCH, ':id/move'],
      ['changeType', RequestMethod.PATCH, ':id/type'],
    ])('%s is %s %s', (route, method, path) => {
      expect(Reflect.getMetadata(METHOD_METADATA, handler(route))).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, handler(route))).toBe(path);
    });

    it('ids in the path and the projectId in the query must be UUIDs', () => {
      for (const route of ['findByProject', 'update', 'remove', 'move', 'changeType'] as const) {
        const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, TasksController, route) as Record<
          string,
          { data?: string; pipes: unknown[] }
        >;
        const key = route === 'findByProject' ? 'projectId' : 'id';
        const arg = Object.values(args).find((a) => a.data === key);
        expect(arg?.pipes, route).toContain(ParseUUIDPipe);
      }
    });

    it('deleting a task answers 204 (no body); the others keep the default status', () => {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler('remove'))).toBe(204);
      for (const route of ['findByProject', 'create', 'update', 'move', 'changeType'] as const)
        expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(route)), route).toBeUndefined();
    });

    it('a viewer can list the tasks: the project is the one in the query', async () => {
      expect(access('findByProject')?.role).toBe('viewer');
      await expect(
        locate(access('findByProject')!.project, { query: { projectId: PROJECT } }),
      ).resolves.toEqual({ projectId: PROJECT });
      // A read tells no one.
      expect(broadcast('findByProject')).toBeUndefined();
    });

    it('creating a task needs an editor of the project named in the body, and tells the others', async () => {
      expect(access('create')?.role).toBe('editor');
      await expect(
        locate(access('create')!.project, { body: { projectId: PROJECT } }),
      ).resolves.toEqual({ projectId: PROJECT });
      expect(broadcast('create')).toMatchObject({ entity: 'task', action: 'create' });
      await expect(
        locate(broadcast('create')!.project, { body: { projectId: PROJECT } }),
      ).resolves.toEqual({ projectId: PROJECT });
      // A new row has no version to check.
      expect(takesIfMatch('create')).toBe(false);
    });

    it.each<[Route, 'update' | 'delete']>([
      ['update', 'update'],
      ['remove', 'delete'],
      ['move', 'update'],
      ['changeType', 'update'],
    ])(
      '%s needs an editor of the task’s project, is checked for conflicts and tells the others (%s)',
      async (route, action) => {
        expect(access(route)?.role).toBe('editor');
        // The project is the task's, found from the id in the path; a 404 names a task.
        const project = access(route)!.project;
        expect(project.thing).toBe('Task');
        await expect(locate(project, { params: { id: TASK } })).resolves.toEqual({
          projectId: PROJECT,
          entity: Task,
          id: TASK,
        });
        expect(broadcast(route)).toMatchObject({ entity: 'task', action });
        await expect(locate(broadcast(route)!.project, { params: { id: TASK } })).resolves.toEqual({
          projectId: PROJECT,
          entity: Task,
          id: TASK,
        });
        expect(takesIfMatch(route)).toBe(true);
      },
    );
  });

  describe('findByProject', () => {
    it('lists the tasks of the project in the query, as the service answers them', async () => {
      const tasks = [{ id: TASK }];
      service.findByProject.mockResolvedValue(tasks);
      await expect(controller.findByProject(PROJECT)).resolves.toBe(tasks);
      expect(service.findByProject).toHaveBeenCalledWith(PROJECT);
    });
  });

  describe('create', () => {
    it('hands the body to the service and answers the new task', async () => {
      const dto = {
        name: 'Design',
        projectId: PROJECT,
        startDate: new Date('2026-01-05'),
        endDate: new Date('2026-01-09'),
        color: '#3b82f6',
      } as CreateTaskDto;
      const created = { id: TASK, ...dto };
      service.create.mockResolvedValue(created);
      await expect(controller.create(dto)).resolves.toBe(created);
      expect(service.create).toHaveBeenCalledWith(dto);
    });

    it('a refusal of the service passes through unchanged', async () => {
      const error = new BadRequestException('A milestone cannot hold tasks');
      service.create.mockRejectedValue(error);
      await expect(controller.create({ projectId: PROJECT } as CreateTaskDto)).rejects.toBe(error);
    });
  });

  describe('update', () => {
    it('hands the id and the changes to the service and answers the task', async () => {
      const updated = { id: TASK, name: 'Build' };
      service.update.mockResolvedValue(updated);
      await expect(controller.update(TASK, { name: 'Build' })).resolves.toBe(updated);
      expect(service.update).toHaveBeenCalledWith(TASK, { name: 'Build' });
    });

    it('a missing task is the service’s 404, unchanged', async () => {
      const error = new NotFoundException('Task not found');
      service.update.mockRejectedValue(error);
      await expect(controller.update(TASK, { progress: 50 })).rejects.toBe(error);
    });
  });

  describe('remove', () => {
    it('deletes the task by id and answers nothing', async () => {
      service.remove.mockResolvedValue(undefined);
      await expect(controller.remove(TASK)).resolves.toBeUndefined();
      expect(service.remove).toHaveBeenCalledWith(TASK);
    });

    it('a missing task is the service’s 404, unchanged', async () => {
      const error = new NotFoundException('Task not found');
      service.remove.mockRejectedValue(error);
      await expect(controller.remove(TASK)).rejects.toBe(error);
    });
  });

  describe('move', () => {
    it('passes the group and the index of the body apart', async () => {
      const moved = { id: TASK, parentId: GROUP, order: 2 };
      service.move.mockResolvedValue(moved);
      await expect(controller.move(TASK, { parentId: GROUP, index: 2 })).resolves.toBe(moved);
      expect(service.move).toHaveBeenCalledWith(TASK, GROUP, 2);
    });

    it('null moves the task to the top level', async () => {
      service.move.mockResolvedValue({ id: TASK, parentId: null });
      await controller.move(TASK, { parentId: null, index: 0 });
      expect(service.move).toHaveBeenCalledWith(TASK, null, 0);
    });

    it('a move the service refuses passes through unchanged', async () => {
      const error = new BadRequestException('A task cannot go inside itself');
      service.move.mockRejectedValue(error);
      await expect(controller.move(TASK, { parentId: TASK, index: 0 })).rejects.toBe(error);
    });
  });

  describe('changeType', () => {
    it('passes the new type of the body and answers the task', async () => {
      const changed = { id: TASK, type: 'milestone' };
      service.changeType.mockResolvedValue(changed);
      await expect(controller.changeType(TASK, { type: 'milestone' })).resolves.toBe(changed);
      expect(service.changeType).toHaveBeenCalledWith(TASK, 'milestone');
    });

    it('a change the service refuses passes through unchanged', async () => {
      const error = new BadRequestException('A group with tasks must stay a group');
      service.changeType.mockRejectedValue(error);
      await expect(controller.changeType(TASK, { type: 'task' })).rejects.toBe(error);
    });
  });
});
