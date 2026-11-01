import type { EntityManager } from 'typeorm';
import type { ProgressRow } from './scheduling/group-progress.js';
import { fitGroupProgress } from './task-rows.js';

// fitGroupProgress (#80): what it writes and what it returns, on a fake manager.

const managerWith = (rows: ProgressRow[]) => {
  const query = vi.fn((sql: string, _parameters?: unknown[]) =>
    Promise.resolve(sql.startsWith('SELECT') ? rows : []),
  );
  return { manager: { query } as unknown as EntityManager, query };
};

describe('fitGroupProgress', () => {
  it('saves the groups that are off in one statement and returns them', async () => {
    const { manager, query } = managerWith([
      { id: 'g', parentId: null, type: 'group', progress: 0 },
      { id: 'a', parentId: 'g', type: 'task', progress: 20 },
      { id: 'b', parentId: 'g', type: 'task', progress: 60 },
    ]);

    await expect(fitGroupProgress(manager, 'p')).resolves.toEqual([{ id: 'g', progress: 40 }]);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]![0]).toMatch(/^UPDATE/);
    expect(query.mock.calls[1]![1]).toEqual([['g'], [40]]);
  });

  it('writes nothing and returns none when every group is right', async () => {
    const { manager, query } = managerWith([
      { id: 'g', parentId: null, type: 'group', progress: 50 },
      { id: 'a', parentId: 'g', type: 'task', progress: 50 },
    ]);

    await expect(fitGroupProgress(manager, 'p')).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('lets a failed write fail, so the caller rolls back', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'g', parentId: null, type: 'group', progress: 0 },
        { id: 'a', parentId: 'g', type: 'task', progress: 80 },
      ])
      .mockRejectedValueOnce(new Error('connection lost'));

    await expect(fitGroupProgress({ query } as unknown as EntityManager, 'p')).rejects.toThrow(
      'connection lost',
    );
  });
});
