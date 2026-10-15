import type { EntityManager } from 'typeorm';

/**
 * What the history (revisions) does to any row it follows, whatever its table: reads and sets the
 * row's version (backend #21: the number of its last revision), and deletes the row (undo). Each
 * domain makes these for its own table (task-rows.ts, event-rows.ts...), so the table's name is
 * only written by its domain (#55). In the caller's transaction, on its manager.
 */
export interface VersionedRows {
  /** The row's version; null when the row is gone. */
  versionOf(manager: EntityManager, id: string): Promise<number | null>;
  setVersion(manager: EntityManager, id: string, version: number): Promise<void>;
  remove(manager: EntityManager, id: string): Promise<void>;
}

export const versionedRows = (table: string): VersionedRows => ({
  async versionOf(manager, id) {
    const [row] = await manager.query<{ version: number }[]>(
      `SELECT "version" FROM "${table}" WHERE "id" = $1`,
      [id],
    );
    return row?.version ?? null;
  },
  async setVersion(manager, id, version) {
    await manager.query(`UPDATE "${table}" SET "version" = $2 WHERE "id" = $1`, [id, version]);
  },
  async remove(manager, id) {
    await manager.query(`DELETE FROM "${table}" WHERE "id" = $1`, [id]);
  },
});
