// Provisions the dev database using the local `postgres` superuser.
// psql prompts for the superuser password (or set PGPASSWORD).
import 'dotenv/config';
import { spawnSync } from 'node:child_process';

const psql = 'psql';

const result = spawnSync(
  psql,
  [
    '-h',
    process.env.DB_HOST,
    '-p',
    process.env.DB_PORT ?? '5432',
    '-U',
    process.env.PG_SUPERUSER ?? 'postgres',
    '-d',
    'postgres',
    '-f',
    'scripts/db-setup.sql',
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
