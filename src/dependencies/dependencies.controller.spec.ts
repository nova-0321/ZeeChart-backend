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
import { Task } from '../tasks/entities/task.entity.js';
import { DependenciesController } from './dependencies.controller.js';
import { DependenciesService } from './dependencies.service.js';
import { TaskDependency } from './entities/task-dependency.entity.js';

// Where @nestjs/swagger keeps a route's documented parameters, headers among them (its constants
// aren't exported).
const API_PARAMETERS = 'swagger/apiParameters';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const FROM = '22222222-2222-4222-8222-222222222222';
const TO = '33333333-3333-4333-8333-333333333333';
const LINK = '44444444-4444-4444-8444-444444444444';

type Route = keyof DependenciesController;
const handler = (route: Route) => DependenciesController.prototype[route] as object;
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

describe('DependenciesController', () => {
  let controller: DependenciesController;
  const service = {
    findByProject: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DependenciesController],
      // The controller only delegates; the service has its own spec.
      providers: [{ provide: DependenciesService, useValue: service }],
    })
      // Sign-in, membership and roles are tested end to end (test/ownership.e2e-spec.ts,
      // test/members.e2e-spec.ts); here only what each route declares for them.
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ProjectAccessGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<DependenciesController>(DependenciesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('routes', () => {
    it('every route is under /dependencies, behind sign-in and the project access check', () => {
      expect(Reflect.getMetadata(PATH_METADATA, DependenciesController)).toBe('dependencies');
      expect(Reflect.getMetadata(GUARDS_METADATA, DependenciesController)).toEqual([
        AuthGuard,
        ProjectAccessGuard,
      ]);
    });

    it.each<[Route, RequestMethod, string]>([
      ['findByProject', RequestMethod.GET, '/'],
      ['create', RequestMethod.POST, '/'],
      ['update', RequestMethod.PATCH, ':id'],
      ['remove', RequestMethod.DELETE, ':id'],
    ])('%s is %s %s', (route, method, path) => {
      expect(Reflect.getMetadata(METHOD_METADATA, handler(route))).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, handler(route))).toBe(path);
    });

    it('ids in the path and the projectId in the query must be UUIDs', () => {
      for (const route of ['findByProject', 'update', 'remove'] as const) {
        const args = Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          DependenciesController,
          route,
        ) as Record<string, { data?: string; pipes: unknown[] }>;
        const key = route === 'findByProject' ? 'projectId' : 'id';
        const arg = Object.values(args).find((a) => a.data === key);
        expect(arg?.pipes, route).toContain(ParseUUIDPipe);
      }
    });

    it('deleting a link answers 204 (no body); the others keep the default status', () => {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler('remove'))).toBe(204);
      for (const route of ['findByProject', 'create', 'update'] as const)
        expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler(route)), route).toBeUndefined();
    });

    it('a viewer can list the links: the project is the one in the query', async () => {
      expect(access('findByProject')?.role).toBe('viewer');
      await expect(
        locate(access('findByProject')!.project, { query: { projectId: PROJECT } }),
      ).resolves.toEqual({ projectId: PROJECT });
      // A read tells no one.
      expect(broadcast('findByProject')).toBeUndefined();
    });

    it('creating a link needs an editor of its first task’s project, and tells the others', async () => {
      expect(access('create')?.role).toBe('editor');
      // The body has no project: it is the one of the task the link starts from (fromTaskId), and
      // a 404 names a task. (The service checks the other task is in the same project.)
      const body = { fromTaskId: FROM, toTaskId: TO };
      const project = access('create')!.project;
      expect(project.thing).toBe('Task');
      await expect(locate(project, { body })).resolves.toEqual({
        projectId: PROJECT,
        entity: Task,
        id: FROM,
      });
      expect(broadcast('create')).toMatchObject({ entity: 'dependency', action: 'create' });
      await expect(locate(broadcast('create')!.project, { body })).resolves.toEqual({
        projectId: PROJECT,
        entity: Task,
        id: FROM,
      });
      // A new row has no version to check.
      expect(takesIfMatch('create')).toBe(false);
    });

    it.each<[Route, 'update' | 'delete']>([
      ['update', 'update'],
      ['remove', 'delete'],
    ])(
      '%s needs an editor of the link’s project, is checked for conflicts and tells the others (%s)',
      async (route, action) => {
        expect(access(route)?.role).toBe('editor');
        // The project is the link's, found from the id in the path; a 404 names a link.
        const project = access(route)!.project;
        expect(project.thing).toBe('Link');
        await expect(locate(project, { params: { id: LINK } })).resolves.toEqual({
          projectId: PROJECT,
          entity: TaskDependency,
          id: LINK,
        });
        expect(broadcast(route)).toMatchObject({ entity: 'dependency', action });
        await expect(locate(broadcast(route)!.project, { params: { id: LINK } })).resolves.toEqual({
          projectId: PROJECT,
          entity: TaskDependency,
          id: LINK,
        });
        expect(takesIfMatch(route)).toBe(true);
      },
    );
  });

  describe('findByProject', () => {
    it('lists the links of the project in the query, as the service answers them', async () => {
      const links = [{ id: LINK }];
      service.findByProject.mockResolvedValue(links);
      await expect(controller.findByProject(PROJECT)).resolves.toBe(links);
      expect(service.findByProject).toHaveBeenCalledWith(PROJECT);
    });
  });

  describe('create', () => {
    it('hands the body to the service and answers the new link', async () => {
      const dto = { fromTaskId: FROM, toTaskId: TO, type: 'SS' as const, lagDays: 2 };
      const created = { id: LINK, projectId: PROJECT, ...dto };
      service.create.mockResolvedValue(created);
      await expect(controller.create(dto)).resolves.toBe(created);
      expect(service.create).toHaveBeenCalledWith(dto);
    });

    it('a link the service refuses (self link, duplicate, cycle) passes through unchanged', async () => {
      const error = new BadRequestException('This link would make a cycle');
      service.create.mockRejectedValue(error);
      await expect(controller.create({ fromTaskId: FROM, toTaskId: TO })).rejects.toBe(error);
    });
  });

  describe('update', () => {
    it('hands the id and the changes to the service and answers the link', async () => {
      const updated = { id: LINK, type: 'FF', lagDays: -1 };
      service.update.mockResolvedValue(updated);
      await expect(controller.update(LINK, { type: 'FF', lagDays: -1 })).resolves.toBe(updated);
      expect(service.update).toHaveBeenCalledWith(LINK, { type: 'FF', lagDays: -1 });
    });

    it('a missing link is the service’s 404, unchanged', async () => {
      const error = new NotFoundException('Link not found');
      service.update.mockRejectedValue(error);
      await expect(controller.update(LINK, { lagDays: 1 })).rejects.toBe(error);
    });
  });

  describe('remove', () => {
    it('deletes the link by id and answers nothing', async () => {
      service.remove.mockResolvedValue(undefined);
      await expect(controller.remove(LINK)).resolves.toBeUndefined();
      expect(service.remove).toHaveBeenCalledWith(LINK);
    });

    it('a missing link is the service’s 404, unchanged', async () => {
      const error = new NotFoundException('Link not found');
      service.remove.mockRejectedValue(error);
      await expect(controller.remove(LINK)).rejects.toBe(error);
    });
  });
});
