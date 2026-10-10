import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Deletes the test accounts whose email starts with `prefix`, and every project any of them is a
 * member of (with all in it, by cascade). Projects first: deleting an account only removes its
 * memberships, so its projects would otherwise be left with no members at all.
 */
export const deleteTestAccounts = async (app: INestApplication, prefix: string) => {
  const db = app.get(DataSource);
  const pattern = `${prefix}%`;
  await db.query(
    `DELETE FROM "projects" p WHERE EXISTS (
       SELECT 1 FROM "members" m JOIN "users" u ON u."id" = m."userId"
       WHERE m."projectId" = p."id" AND u."email" LIKE $1)`,
    [pattern],
  );
  await db.query(`DELETE FROM "users" WHERE "email" LIKE $1`, [pattern]);
};
