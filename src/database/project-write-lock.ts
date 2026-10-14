import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { RequestTransaction } from './request-transaction.js';

/**
 * Writes to one project run one after another, on every server instance: each write is one
 * transaction (RequestTransaction) that starts by taking a Postgres advisory lock for its project
 * (pg_advisory_xact_lock), held until it commits or rolls back, so it is never left held.
 *
 * Writes to the same project on this instance first queue up here in memory, so only one of them at
 * a time holds (or waits with) a database connection, and a burst on one project leaves the
 * connections free for everything else.
 *
 * The key is the two-number form, (hashtext('project-writes'), hashtext(projectId)): Postgres
 * keeps it apart from the one-number keys the other locks use (revisions, versions, project
 * names), so it can never collide with one a write takes inside it and wait for itself.
 */
@Injectable()
export class ProjectWriteLock {
  /** The last write queued for each project on this instance. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly tx: RequestTransaction) {}

  /** Runs `work` in one transaction holding the project's lock. */
  run<T>(projectId: string, work: (manager: EntityManager) => Promise<T>): Promise<T> {
    // One project, one lock: the id may come from the request as sent, in any letter case.
    const key = projectId.toLowerCase();
    return this.inTurn(key, () =>
      this.tx.run(async (manager) => {
        await manager.query(
          `SELECT pg_advisory_xact_lock(hashtext('project-writes'), hashtext($1))`,
          [key],
        );
        return work(manager);
      }),
    );
  }

  /** Runs `work` after the writes to the same project queued before it (whatever their outcome). */
  private inTurn<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.catch(() => undefined);
    this.queues.set(projectId, settled);
    void settled.then(() => {
      if (this.queues.get(projectId) === settled) this.queues.delete(projectId);
    });
    return run;
  }
}
