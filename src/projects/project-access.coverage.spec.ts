/// <reference types="vite/client" />
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { NO_PROJECT_CHECK, PROJECT_ACCESS, ProjectAccessGuard } from './project-access.js';

// Every route outside sign-in and health works on someone's project, so it must say how
// to find it and the role it needs (@ProjectAccess) or that there's nothing to check
// (@NoProjectCheck), and its controller must run ProjectAccessGuard. A new route without them fails
// here, instead of quietly letting anyone at other people's projects.

const OPEN_CONTROLLERS = new Set(['auth', 'health']);

const modules = import.meta.glob<Record<string, unknown>>('../**/*.controller.ts', {
  eager: true,
});

const routes = () =>
  Object.values(modules).flatMap((exports) =>
    Object.values(exports)
      .filter((value): value is new (...args: never[]) => unknown => typeof value === 'function')
      .flatMap((controller) => {
        const base = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
        if (base === undefined || OPEN_CONTROLLERS.has(base)) return [];
        const guards = (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as unknown[];
        return Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
          const handler = (controller.prototype as Record<string, unknown>)[name] as object;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
          if (method === undefined) return [];
          const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
          return [
            {
              route: `${RequestMethod[method]} /${base}/${path}`
                .replace(/\/+$/, '')
                .replace(/\/\/+/g, '/'),
              guarded: guards.includes(ProjectAccessGuard),
              marked:
                Reflect.hasMetadata(PROJECT_ACCESS, handler) ||
                Reflect.hasMetadata(NO_PROJECT_CHECK, handler),
            },
          ];
        });
      }),
  );

describe('project access coverage', () => {
  it('finds the project routes', () => {
    // 42 today: projects 7, tasks 7, dependencies 4, events 4, members 3, invitations 4,
    // invite links 2,
    // revisions 2, versions 6, undo 3. A new one fails on purpose.
    expect(routes().length).toBe(42);
  });

  it('every one runs the access guard and says how to find its project', () => {
    expect(
      routes()
        .filter((r) => !r.guarded || !r.marked)
        .map((r) => r.route),
    ).toEqual([]);
  });
});
