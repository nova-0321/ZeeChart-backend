import { envValidationSchema } from './env.validation.js';

// API_DOCS: the docs (/docs, /docs-json) are off in production unless asked for, on elsewhere.

const BASE = {
  DB_HOST: 'localhost',
  DB_USERNAME: 'u',
  DB_PASSWORD: 'p',
  DB_NAME: 'd',
  JWT_SECRET: 'a-real-secret-of-at-least-32-characters-0123456789',
};
const apiDocs = (env: Record<string, string>) =>
  (envValidationSchema.validate({ ...BASE, ...env }).value as { API_DOCS: unknown }).API_DOCS;

describe('env validation: API_DOCS', () => {
  it('is off in production unless set', () => {
    expect(apiDocs({ NODE_ENV: 'production' })).toBe(false);
    expect(apiDocs({ NODE_ENV: 'production', API_DOCS: 'true' })).toBe(true);
  });

  it('is on in development and tests unless set', () => {
    expect(apiDocs({ NODE_ENV: 'development' })).toBe(true);
    expect(apiDocs({ NODE_ENV: 'test' })).toBe(true);
    expect(apiDocs({ NODE_ENV: 'development', API_DOCS: 'false' })).toBe(false);
  });

  it('is on in development when NODE_ENV is not set', () => {
    expect(apiDocs({})).toBe(true);
  });
});
