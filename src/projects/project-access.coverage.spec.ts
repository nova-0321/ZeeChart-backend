/// <reference types="vite/client" />
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { NO_PROJECT_CHECK, OWNED_PROJECT, ProjectOwnerGuard } from './project-access.js';

// Every route outside sign-in, health and the root works on someone's project, so it must say how
// to find it (@OwnedProject) or that there's nothing to check (@NoProjectCheck), and its
// controller must run ProjectOwnerGuard. A new route without them fails here, instead of quietly
// letting anyone at other people's projects.

const OPEN_CONTROLLERS = new Set(['auth', 'health', '/', '']);

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
              guarded: guards.includes(ProjectOwnerGuard),
              marked:
                Reflect.hasMetadata(OWNED_PROJECT, handler) ||
                Reflect.hasMetadata(NO_PROJECT_CHECK, handler),
            },
          ];
        });
      }),
  );

describe('project access coverage', () => {
  it('finds the project routes', () => {
    // 22 today: projects 7, tasks 7, dependencies 4, events 4. A new one fails on purpose.
    expect(routes().length).toBe(22);
  });

  it('every one runs the owner guard and says how to find its project', () => {
    expect(
      routes()
        .filter((r) => !r.guarded || !r.marked)
        .map((r) => r.route),
    ).toEqual([]);
  });
});
