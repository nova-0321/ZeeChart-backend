/// <reference types="vite/client" />
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { BROADCAST, NO_BROADCAST } from './broadcast.decorator.js';

// Every route that writes must say whether it tells the others (@Broadcast) or not
// (@NoBroadcast), so a new route can't silently leave other screens out of date.

const WRITES = new Set([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

// Every controller in the code, found by file name.
const modules = import.meta.glob<Record<string, unknown>>('../**/*.controller.ts', {
  eager: true,
});

const writeRoutes = () =>
  Object.values(modules).flatMap((exports) =>
    Object.values(exports)
      .filter((value): value is new (...args: never[]) => unknown => typeof value === 'function')
      .flatMap((controller) => {
        const base = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
        if (base === undefined) return [];
        return Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
          const handler = (controller.prototype as Record<string, unknown>)[name];
          const method = Reflect.getMetadata(METHOD_METADATA, handler as object) as
            RequestMethod | undefined;
          if (method === undefined || !WRITES.has(method)) return [];
          const path = Reflect.getMetadata(PATH_METADATA, handler as object) as string;
          return [
            {
              route: `${RequestMethod[method]} /${base}/${path}`
                .replace(/\/+$/, '')
                .replace(/\/\/+/g, '/'),
              marked:
                Reflect.hasMetadata(BROADCAST, handler as object) ||
                Reflect.hasMetadata(NO_BROADCAST, handler as object),
            },
          ];
        });
      }),
  );

describe('broadcast coverage', () => {
  it('finds the write routes', () => {
    // 22 today: projects 5, tasks 6, dependencies 3, events 3, members 3, auth 2. A new one makes
    // this fail on purpose.
    expect(writeRoutes().length).toBe(22);
  });

  it('every write route is @Broadcast or @NoBroadcast', () => {
    expect(
      writeRoutes()
        .filter((route) => !route.marked)
        .map((route) => route.route),
    ).toEqual([]);
  });
});
