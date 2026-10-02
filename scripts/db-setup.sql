-- Idempotent dev provisioning: creates/updates the app role and database.
-- Run via `npm run db:setup` (reads DB_USERNAME, DB_PASSWORD, DB_NAME from env).
\set ON_ERROR_STOP on
\getenv app_user DB_USERNAME
\getenv app_password DB_PASSWORD
\getenv app_db DB_NAME

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user')
\gexec

-- Keep the password in sync with .env on re-runs.
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'app_user', :'app_password')
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'app_db', :'app_user')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'app_db')
\gexec

-- PG15+ only lets the database owner create in `public`; fix pre-existing DBs.
SELECT format('ALTER DATABASE %I OWNER TO %I', :'app_db', :'app_user')
\gexec

\echo Database ready: :app_db (owner :app_user)
