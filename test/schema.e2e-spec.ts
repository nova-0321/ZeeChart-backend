import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';

// The database's shape, as the migrations made it.
describe('The schema (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('keeps every time as a moment (timestamptz), never a plain timestamp (#59)', async () => {
    const columns = await app.get(DataSource).query<{ column: string; type: string }[]>(
      `SELECT table_name || '.' || column_name AS "column", data_type AS "type"
         FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type LIKE 'timestamp%'
        ORDER BY 1`,
    );
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.filter((c) => c.type !== 'timestamp with time zone')).toEqual([]);
  });
});
