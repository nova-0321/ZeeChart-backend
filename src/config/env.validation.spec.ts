import { envValidationSchema, TEST_JWT_SECRET } from './env.validation.js';

// JWT_SECRET signs the sign-in tokens, so a known value lets anyone sign in as anyone. It must be
// set everywhere except tests, and a value that has been in the repository is refused.

const DB = { DB_HOST: 'localhost', DB_USERNAME: 'u', DB_PASSWORD: 'p', DB_NAME: 'd' };
const SECRET = 'a-real-secret-of-at-least-32-characters-0123456789';
const validate = (env: Record<string, string>) => envValidationSchema.validate({ ...DB, ...env });

describe('env validation: JWT_SECRET', () => {
  it.each(['development', 'production'])('is required when NODE_ENV=%s', (NODE_ENV) => {
    const { error } = validate({ NODE_ENV });
    expect(error?.message).toMatch(/JWT_SECRET is not set/);
  });

  it('is required when NODE_ENV is not set at all (it defaults to development)', () => {
    const { error, value } = validate({});
    expect((value as { NODE_ENV: string }).NODE_ENV).toBe('development');
    expect(error?.message).toMatch(/JWT_SECRET is not set/);
  });

  it.each(['zeechart-development-secret-not-for-production', TEST_JWT_SECRET])(
    'refuses a value published in the repository (%s)',
    (JWT_SECRET) => {
      for (const NODE_ENV of ['development', 'production']) {
        expect(validate({ NODE_ENV, JWT_SECRET }).error?.message).toMatch(/published/);
      }
    },
  );

  it('refuses one shorter than 32 characters', () => {
    expect(
      validate({ NODE_ENV: 'production', JWT_SECRET: 'short-secret-1234' }).error,
    ).toBeDefined();
  });

  it('accepts a real secret', () => {
    for (const NODE_ENV of ['development', 'production']) {
      const { error, value } = validate({ NODE_ENV, JWT_SECRET: SECRET });
      expect(error).toBeUndefined();
      expect((value as { JWT_SECRET: string }).JWT_SECRET).toBe(SECRET);
    }
  });

  it('uses the test-only value in tests when none is set', () => {
    const { error, value } = validate({ NODE_ENV: 'test' });
    expect(error).toBeUndefined();
    expect((value as { JWT_SECRET: string }).JWT_SECRET).toBe(TEST_JWT_SECRET);
  });
});
