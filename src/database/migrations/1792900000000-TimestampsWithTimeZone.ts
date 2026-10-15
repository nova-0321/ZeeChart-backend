import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Every created/updated/joined time that was a plain `timestamp`, by table. */
const COLUMNS: [table: string, column: string][] = [
  ['events', 'createdAt'],
  ['events', 'updatedAt'],
  ['invitations', 'createdAt'],
  ['members', 'joinedAt'],
  ['project_versions', 'createdAt'],
  ['projects', 'createdAt'],
  ['projects', 'updatedAt'],
  ['revisions', 'createdAt'],
  ['task_dependencies', 'createdAt'],
  ['tasks', 'createdAt'],
  ['tasks', 'updatedAt'],
  ['users', 'createdAt'],
  ['users', 'updatedAt'],
];

/**
 * All times as `timestamptz` (#59), as `invitations.expiresAt` already was: a moment, not a clock
 * reading that means another moment in another time zone.
 *
 * No USING clause on purpose: the stored values were written by the database itself (`now()`,
 * CURRENT_TIMESTAMP) as the time in its own time zone, and casting `timestamp` to `timestamptz`
 * reads them in that same time zone, so each keeps the moment it meant, whatever the server's time
 * zone is. (`AT TIME ZONE 'UTC'` would shift them on a database that isn't in UTC.)
 */
export class TimestampsWithTimeZone1792900000000 implements MigrationInterface {
  name = 'TimestampsWithTimeZone1792900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of COLUMNS) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE TIMESTAMP WITH TIME ZONE`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of COLUMNS) {
      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE TIMESTAMP`);
    }
  }
}
