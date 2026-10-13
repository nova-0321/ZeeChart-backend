import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * A password hash in the stored format, made with the settings given: how an older version of the
 * app stored it (the tests of moving to stronger settings need one).
 */
export const hashWith = async (password: string, N: number, r: number, p: number) => {
  const salt = randomBytes(16);
  // Node refuses to use more than maxmem; this needs 128 * N * r bytes.
  const key = await scryptAsync(password, salt, 64, { N, r, p, maxmem: 128 * N * r * 2 });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
};
