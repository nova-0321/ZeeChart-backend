import { envValidationSchema } from './env.validation.js';

// TRUST_PROXY: how many proxies to trust (a number), or false. Never `true` (trust every entry of
// X-Forwarded-For, which a client can fill in itself).

const DB = { DB_HOST: 'localhost', DB_USERNAME: 'u', DB_PASSWORD: 'p', DB_NAME: 'd' };
const trustProxy = (value?: string) => {
  const { error, value: env } = envValidationSchema.validate({
    ...DB,
    NODE_ENV: 'test',
    ...(value === undefined ? {} : { TRUST_PROXY: value }),
  });
  return { error, trust: (env as { TRUST_PROXY: unknown }).TRUST_PROXY };
};

describe('env validation: TRUST_PROXY', () => {
  it('is off when not set (clients connect directly)', () => {
    expect(trustProxy()).toEqual({ error: undefined, trust: false });
  });

  it('takes a hop count', () => {
    expect(trustProxy('1')).toEqual({ error: undefined, trust: 1 });
    expect(trustProxy('2').trust).toBe(2);
    expect(trustProxy('false')).toEqual({ error: undefined, trust: false });
  });

  it('refuses true, negative numbers and words', () => {
    for (const value of ['true', '-1', 'yes', '1.5']) expect(trustProxy(value).error).toBeDefined();
  });
});
