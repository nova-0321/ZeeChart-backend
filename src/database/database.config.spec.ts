import { buildDataSourceOptions } from './database.config.js';
import { envValidationSchema } from '../config/env.validation.js';

const required = {
  DB_HOST: 'localhost',
  DB_USERNAME: 'postgres',
  DB_PASSWORD: 'postgres',
  DB_NAME: 'zeechart',
};
const sslWith = (env: Record<string, string>) =>
  (buildDataSourceOptions((key) => env[key]) as { ssl?: unknown }).ssl;

describe('database SSL (DB_SSL)', () => {
  it('is off unless asked for (local Postgres, CI)', () => {
    expect(sslWith(required)).toBe(false);
    expect(sslWith({ ...required, DB_SSL: 'false' })).toBe(false);
  });

  it('true: on, with the certificate checked', () => {
    expect(sslWith({ ...required, DB_SSL: 'true' })).toBe(true);
  });

  it('no-verify: on, without checking the certificate', () => {
    expect(sslWith({ ...required, DB_SSL: 'no-verify' })).toEqual({ rejectUnauthorized: false });
  });

  it('anything else is refused at startup', () => {
    expect(envValidationSchema.validate({ ...required, DB_SSL: 'yes' }).error?.message).toMatch(
      /DB_SSL/,
    );
    expect(envValidationSchema.validate({ ...required }).value).toMatchObject({ DB_SSL: 'false' });
  });
});
