import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TaskDto } from './task.dto.js';

const PROJECT_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

/** A request body the add-task form can send: only the fields it has. */
const minimal = {
  name: 'Design review',
  startDate: '2026-10-07',
  endDate: '2026-10-09',
  color: '#2a78d6',
  projectId: PROJECT_ID,
};

/** Runs the same transform + validation as the global ValidationPipe and returns the bad fields. */
async function badFields(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(TaskDto, body));
  return errors.map((error) => error.property).sort();
}

describe('TaskDto', () => {
  it('accepts the fields the add-task form sends, with no parentId, progress, order, type or priority', async () => {
    expect(await badFields(minimal)).toEqual([]);
  });

  it('accepts a missing or null parentId (a top-level task) and a real one', async () => {
    expect(await badFields({ ...minimal, parentId: null })).toEqual([]);
    expect(await badFields({ ...minimal, parentId: PROJECT_ID })).toEqual([]);
  });

  it('rejects a parentId that is not a UUID', async () => {
    expect(await badFields({ ...minimal, parentId: 'abc' })).toEqual(['parentId']);
  });

  it('rejects an empty or whitespace-only name, and trims a padded one', async () => {
    expect(await badFields({ ...minimal, name: '   ' })).toEqual(['name']);
    expect(plainToInstance(TaskDto, { ...minimal, name: '  Plan  ' }).name).toBe('Plan');
  });

  it('rejects a name longer than the 255 characters the column was meant for', async () => {
    expect(await badFields({ ...minimal, name: 'x'.repeat(256) })).toEqual(['name']);
  });

  it('only accepts known types and priorities', async () => {
    expect(await badFields({ ...minimal, type: 'milestone', priority: 'high' })).toEqual([]);
    expect(await badFields({ ...minimal, type: 'epic' })).toEqual(['type']);
    expect(await badFields({ ...minimal, priority: 'urgent' })).toEqual(['priority']);
  });

  it('only accepts a #rrggbb color', async () => {
    expect(await badFields({ ...minimal, color: 'blue' })).toEqual(['color']);
    expect(await badFields({ ...minimal, color: '#12345' })).toEqual(['color']);
    expect(await badFields({ ...minimal, color: '#ABCDEF' })).toEqual([]);
  });

  it('keeps progress between 0 and 100 and order at 0 or more', async () => {
    expect(await badFields({ ...minimal, progress: 100, order: 0 })).toEqual([]);
    expect(await badFields({ ...minimal, progress: 101 })).toEqual(['progress']);
    expect(await badFields({ ...minimal, progress: -1 })).toEqual(['progress']);
    expect(await badFields({ ...minimal, order: -1 })).toEqual(['order']);
  });

  it('rejects dates that are not ISO dates', async () => {
    expect(await badFields({ ...minimal, startDate: 'tomorrow' })).toEqual(['startDate']);
    expect(await badFields({ ...minimal, endDate: undefined })).toEqual(['endDate']);
  });
});
