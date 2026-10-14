import type { DataSource } from 'typeorm';

/**
 * Runs `work` with the project's writes serialized across every server instance: a Postgres
 * advisory lock, held inside one transaction and released automatically when it ends (commit or
 * rollback) - no risk of it being left held, unlike a session-level lock that depends on every code
 * path remembering to release it (tried and rejected for #50: killing the holding process without
 * an explicit unlock left the lock held until the connection actually closed, which can be
 * indefinite on a pooled connection - see the PR description).
 *
 * `work` keeps using the project's own repositories as it already does (it is not handed the lock's
 * transaction manager): the lock only needs to be *held*, on any connection, for as long as `work`
 * runs, not for every write inside it to share one SQL transaction.
 *
 * Taken exactly once per request, by RevisionInterceptor, around the whole write: the conflict
 * check (#21), the route's own handler, and recording its history. That one call is what protects
 * everything a write can get wrong under a concurrent one on another instance - a stale conflict
 * check, a cycle a row constraint can't express, two creates computing the same "next" order -
 * since none of it can interleave with another request holding the same project's lock. Before
 * this, the only thing serializing any of it within one project was RevisionInterceptor's in-memory
 * queue, which does not hold once more than one server instance is running. Nothing below the
 * interceptor should take this same lock again: it is already held for the request, and a second,
 * nested acquisition on a different pooled connection would deadlock against itself.
 */
export function withProjectWriteLock<T>(
  db: DataSource,
  projectId: string,
  work: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`writes:${projectId}`]);
    return work();
  });
}
