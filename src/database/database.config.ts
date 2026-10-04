import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DataSourceOptions } from 'typeorm';

// ESM has no __dirname; derive it from the module URL.
const __dirname = dirname(fileURLToPath(import.meta.url));

type Getter = (key: string) => string | undefined;

// Shared by the Nest app (DatabaseModule) and the TypeORM CLI (database.data-source.ts).
export const buildDataSourceOptions = (get: Getter): DataSourceOptions => ({
  type: 'postgres',
  host: get('DB_HOST'),
  port: Number(get('DB_PORT') ?? 5432),
  username: get('DB_USERNAME'),
  password: get('DB_PASSWORD'),
  database: get('DB_NAME'),
  entities: [__dirname + '/../**/*.entity.{ts,js}'],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
  logging: get('DB_LOGGING') === 'true',
});
