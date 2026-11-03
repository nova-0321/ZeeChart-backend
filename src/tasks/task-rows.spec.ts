import type { EntityManager } from 'typeorm';
import { fitGroupProgress } from './task-rows.js';

// fitGroupProgress (#80): what it writes and what it returns, on a fake manager. It is given the
// project's rows and never reads them itself (#83).

const fakeManager = () => {
  const query = vi.fn((_sql: string, _parameters?: unknown[]) => Promise.resolve([]));
  return { manager: { query } as unknown as EntityManager, query };
};

describe('fitGroupProgress', () => {
  it('saves the groups that are off in one statement and returns them, reading nothing', async () => {
    const { manager, query } = fakeManager();
    const rows = [
      { id: 'g', parentId: null, type: 'group', progress: 0 },
      { id: 'a', parentId: 'g', type: 'task', progress: 20 },
      { id: 'b', parentId: 'g', type: 'task', progress: 60 },
    ];

    await expect(fitGroupProgress(manager, rows)).resolves.toEqual([{ id: 'g', progress: 40 }]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toMatch(/^UPDATE/);
    expect(query.mock.calls[0]![1]).toEqual([['g'], [40]]);
  });

  it('writes nothing and returns none when every group is right', async () => {
    const { manager, query } = fakeManager();
    const rows = [
      { id: 'g', parentId: null, type: 'group', progress: 50 },
      { id: 'a', parentId: 'g', type: 'task', progress: 50 },
    ];

    await expect(fitGroupProgress(manager, rows)).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('lets a failed write fail, so the caller rolls back', async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error('connection lost'));
    const rows = [
      { id: 'g', parentId: null, type: 'group', progress: 0 },
      { id: 'a', parentId: 'g', type: 'task', progress: 80 },
    ];

    await expect(fitGroupProgress({ query } as unknown as EntityManager, rows)).rejects.toThrow(
      'connection lost',
    );
  });
});
