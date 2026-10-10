import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Passwords are stored as a scrypt hash, never as text. Node's built-in scrypt needs no native
// module. The stored string carries its own parameters, so they can be raised later and old
// hashes still verify:  scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

const derive = (password: string, salt: Buffer, options: ScryptOptions, length: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, length, { ...options, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, { N, r: R, p: P }, KEY_LENGTH);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Whether `password` matches `stored`. False for anything that is not a hash made here. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt64, key64] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt64 || !key64) return false;
  const expected = Buffer.from(key64, 'base64');
  if (expected.length === 0) return false;
  const key = await derive(
    password,
    Buffer.from(salt64, 'base64'),
    { N: Number(n), r: Number(r), p: Number(p) },
    expected.length,
  );
  // Same length by construction; compared in constant time.
  return timingSafeEqual(key, expected);
}

/**
 * A hash of a random password, made once. Signing in with an unknown email still checks the
 * password against it, so the answer takes as long as for a known email (the time does not tell
 * which emails have accounts).
 */
let dummyHash: Promise<string> | undefined;
export const dummyPasswordHash = () =>
  (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));
