import { NotFoundException } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EntityNotFoundError } from 'typeorm';
import { TaskDependency } from '../dependencies/entities/task-dependency.entity.js';
import { ProjectEvent } from '../events/entities/project-event.entity.js';
import { Task } from '../tasks/entities/task.entity.js';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { KNOWN_ENTITIES, notFound, thingOf } from './not-found.js';

// One shape for every 404 (#58): "<Thing> not found".

/** Every source file of the app (not the tests). */
const sources = (dir = 'src'): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });

describe('notFound', () => {
  it('is a 404 that names the thing, without an id', () => {
    const error = notFound('Task');
    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.getStatus()).toBe(404);
    expect(error.message).toBe('Task not found');
  });

  it('names rows as the API calls them: a link, an event, an account', () => {
    expect(thingOf(Task)).toBe('Task');
    expect(thingOf(TaskDependency)).toBe('Link');
    expect(thingOf(ProjectEvent)).toBe('Event');
    expect(thingOf('User')).toBe('Account');
  });

  it('knows every entity of the app (a new table gets a name here, not "Item not found")', () => {
    const entities = sources()
      .filter((file) => file.endsWith('.entity.ts'))
      .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/^export class (\w+)/gm)])
      .map((match) => match[1]);
    expect(entities.length).toBeGreaterThan(0);
    expect(entities.filter((name) => !KNOWN_ENTITIES.includes(name))).toEqual([]);
  });

  it('is the only way a generic 404 is written (no "Not found", "Resource not found", ids)', () => {
    const handWritten = sources()
      .filter((file) => !file.endsWith(join('common', 'not-found.ts')))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, index) => ({ at: `${file}:${index + 1}`, line }))
          .filter(
            ({ line }) =>
              // The shapes #58 found: a bare "Not found", the filter's "Resource not found", an id
              // in the text, and any 404 text written by hand.
              /['`](Resource )?not found['`]/i.test(line) ||
              /`[^`]*\$\{[^}]+\}[^`]*not found[^`]*`/i.test(line) ||
              /NotFoundException\(\s*['`][^'`]*not found/i.test(line),
          ),
      )
      .map(({ at, line }) => `${at} ${line.trim()}`);
    expect(handWritten).toEqual([]);
  });
});

describe('AllExceptionsFilter on a findOneByOrFail that found nothing', () => {
  it('answers 404 "<Thing> not found" for that table', () => {
    const json = vi.fn();
    const filter = new AllExceptionsFilter({
      httpAdapter: {
        reply: (_res: unknown, body: unknown, status: number) => json(status, body),
        getRequestUrl: () => '/dependencies/x',
        getRequestMethod: () => 'PATCH',
      },
    } as never);
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({}),
        getRequest: () => ({ url: '/dependencies/x', method: 'PATCH' }),
      }),
    };
    filter.catch(new EntityNotFoundError(TaskDependency, { id: 'x' }), host as never);
    expect(json).toHaveBeenCalledWith(
      404,
      expect.objectContaining({ statusCode: 404, message: 'Link not found' }),
    );
  });
});
