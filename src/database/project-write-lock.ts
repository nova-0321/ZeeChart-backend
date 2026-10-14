import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { DataSource, type DataSourceOptions, type QueryRunner } from 'typeorm';

/** How many projects one server instance can hold the write lock of at the same time. */
const LOCK_CONNECTIONS = 10;

/**
 * Writes to one project run one after another, on every server instance: a Postgres advisory lock
 * per project (pg_advisory_xact_lock), held around the whole write. It ends with its transaction,
 * so it is never left held, not even when the process dies.
 *
 * The lock is held on a connection of its own, from a small pool kept apart from the app's: the
 * write's own queries still run on the app's pool, outside this transaction. A lock held on an
 * app-pool connection hangs the server for good under a burst of writes: waiting requests fill the
 * pool, each holding a connection, and the one holding the lock then never gets a connection for
 * its own queries.
 *
 * Writes to the same project on this instance first queue up here in memory, so only one of them at
 * a time holds (or waits with) a lock connection, and a burst on one project leaves the others
 * free.
 *
 * The key is the two-number form, (hashtext('project-writes'), hashtext(projectId)): Postgres
 * keeps it apart from the one-number keys the other locks use (revisions, versions, project
 * names), so it can never collide with one a write takes inside it and wait for itself.
 */
@Injectable()
export class ProjectWriteLock implements OnApplicationShutdown {
  private readonly logger = new Logger(ProjectWriteLock.name);
  private readonly locks: DataSource;
  private ready?: Promise<DataSource>;
  /** The last write queued for each project on this instance. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(db: DataSource) {
    this.locks = new DataSource({
      ...db.options,
      entities: [],
      subscribers: [],
      migrations: [],
      poolSize: LOCK_CONNECTIONS,
    } as DataSourceOptions);
  }

  /** Runs `work` once the project's lock is held, and lets the lock go when it ends. */
  run<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    // One project, one lock: the id may come from the request as sent, in any letter case.
    const key = projectId.toLowerCase();
    return this.inTurn(key, () => this.locked(key, work));
  }

  /** Closed with the app's own DataSource, once the server takes no more requests. */
  async onApplicationShutdown() {
    await this.ready?.catch(() => undefined);
    if (this.locks.isInitialized) await this.locks.destroy();
  }

  private async locked<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const runner = (await this.connected()).createQueryRunner();
    try {
      await runner.startTransaction();
      await runner.query(`SELECT pg_advisory_xact_lock(hashtext('project-writes'), hashtext($1))`, [
        projectId,
      ]);
    } catch (error) {
      await this.end(runner);
      throw error;
    }
    try {
      return await work();
    } finally {
      await this.end(runner);
    }
  }

  /** Connects on first use; if that fails, the next write tries again. */
  private connected(): Promise<DataSource> {
    this.ready ??= this.locks.initialize().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  /**
   * The lock's transaction wrote nothing: ending it only lets the lock go. If that fails, the
   * connection is gone and the lock with it; the write's own outcome stands either way.
   */
  private async end(runner: QueryRunner) {
    try {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
    } catch (error) {
      this.logger.warn(`Could not end a project lock's transaction: ${String(error)}`);
    } finally {
      await runner.release();
    }
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
