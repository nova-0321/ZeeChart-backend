import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager, type EntityTarget, type ObjectLiteral } from 'typeorm';

/**
 * One transaction for a whole write (RevisionInterceptor): the route's changes and their history
 * are saved together or not at all. Services read their repositories and run their queries through
 * `manager` / `repo()`: inside a write, that is its transaction; anywhere else, the app's
 * DataSource. A `manager.transaction(...)` inside a write is a savepoint in it, so a step can still
 * be undone on its own.
 *
 * Nothing that runs inside a write may use the DataSource directly: its query would run on another
 * connection, outside the transaction (not undone with it), while this one waits for it.
 */
@Injectable()
export class RequestTransaction {
  private readonly current = new AsyncLocalStorage<EntityManager>();

  constructor(private readonly db: DataSource) {}

  /** The running write's transaction, or the DataSource's manager outside a write. */
  get manager(): EntityManager {
    return this.current.getStore() ?? this.db.manager;
  }

  repo<Entity extends ObjectLiteral>(entity: EntityTarget<Entity>) {
    return this.manager.getRepository(entity);
  }

  /** Runs `work` in a transaction that everything it calls through this class shares. */
  run<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.manager.transaction((manager) => this.current.run(manager, () => work(manager)));
  }
}
