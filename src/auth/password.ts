import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Passwords are stored as a scrypt hash, never as text. Node's built-in scrypt needs no native
// module. The stored string carries its own parameters, so they can be raised later and old
// hashes still verify (and are replaced by a stronger one at the next sign-in, see needsRehash):
//   scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
//
// The cost: N = 2^17, r = 8, p = 1, OWASP's first choice (the client's request). A hash needs
// 128 * N * r bytes: 128 MB, and up to four run at once (Node's thread pool), so the host needs
// that much memory to spare for sign-ins; a smaller one should use one of OWASP's equivalents that
// trade memory for time, e.g. N = 2^15, p = 3 (32 MB per hash). About 0.3 s per hash on a laptop
// core.

const N = 2 ** 17;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
/** The most memory a hash may take, whatever its stored parameters say (128 * N * r bytes). */
const MAX_MEMORY = 256 * 1024 * 1024;

const memoryOf = (n: number, r: number) => 128 * n * r;

const derive = (password: string, salt: Buffer, options: ScryptOptions, length: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      length,
      // scrypt refuses to run when it needs more than maxmem: a little over what it uses.
      { ...options, maxmem: Math.ceil(memoryOf(options.N as number, options.r as number) * 1.1) },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, { N, r: R, p: P }, KEY_LENGTH);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** The parts of a stored hash, or null for anything that is not a hash made here. */
function parse(stored: string) {
  const [scheme, n, r, p, salt64, key64] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt64 || !key64) return null;
  const [cost, block, parallel] = [Number(n), Number(r), Number(p)];
  const sound = [cost, block, parallel].every((value) => Number.isInteger(value) && value > 0);
  // A power of two (scrypt's rule), and not so big that checking one could use up the host.
  if (!sound || (cost & (cost - 1)) !== 0 || memoryOf(cost, block) > MAX_MEMORY) return null;
  const expected = Buffer.from(key64, 'base64');
  if (expected.length === 0) return null;
  return { cost, block, parallel, salt: Buffer.from(salt64, 'base64'), expected };
}

/** Whether `password` matches `stored`. False for anything that is not a hash made here. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = parse(stored);
  if (!parts) return false;
  const key = await derive(
    password,
    parts.salt,
    { N: parts.cost, r: parts.block, p: parts.parallel },
    parts.expected.length,
  );
  // Same length by construction; compared in constant time.
  return timingSafeEqual(key, parts.expected);
}

/**
 * Whether `stored` was made with weaker settings than the current ones: it still verifies, and is
 * replaced by a new hash the next time its owner signs in (the password is only at hand then).
 */
export function needsRehash(stored: string): boolean {
  const parts = parse(stored);
  return !!parts && (parts.cost < N || parts.block < R || parts.parallel < P);
}

/**
 * A hash of a random password, made once. Signing in with an unknown email still checks the
 * password against it, so the answer takes as long as for a known email (the time does not tell
 * which emails have accounts).
 */
let dummyHash: Promise<string> | undefined;
export const dummyPasswordHash = () =>
  (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));
