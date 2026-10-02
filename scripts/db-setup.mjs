// Provisions the dev database using the local `postgres` superuser.
// psql prompts for the superuser password (or set PGPASSWORD).
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const required = ['DB_HOST', 'DB_USERNAME', 'DB_PASSWORD', 'DB_NAME'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}. See .env.example.`);
  process.exit(1);
}

const windowsPsql = 'C:/Program Files/PostgreSQL/18/bin/psql.exe';
const psql =
  process.env.PSQL ?? (existsSync(windowsPsql) ? windowsPsql : 'psql');

const result = spawnSync(
  psql,
  [
    '-h', process.env.DB_HOST,
    '-p', process.env.DB_PORT ?? '5432',
    '-U', process.env.PG_SUPERUSER ?? 'postgres',
    '-d', 'postgres',
    '-f', 'scripts/db-setup.sql',
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
