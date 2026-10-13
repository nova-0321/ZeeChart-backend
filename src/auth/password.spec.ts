import { randomBytes } from 'node:crypto';
import { hashWith } from '../../test/password-hashes.js';
import { hashPassword, needsRehash, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies the right password and refuses a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true);
    await expect(verifyPassword('correct horse batterz', hash)).resolves.toBe(false);
  });

  it('never stores the password, and salts every hash', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toContain('same password');
    expect(a).not.toBe(b);
    // N = 2^17, r = 8, p = 1: OWASP's first choice.
    expect(a.startsWith('scrypt$131072$8$1$')).toBe(true);
  });

  it('refuses anything that is not one of its hashes', async () => {
    for (const stored of ['plain-text', '', 'scrypt$16384$8$1$$', 'bcrypt$x$y$z$a$b']) {
      await expect(verifyPassword('x', stored)).resolves.toBe(false);
    }
  });

  it('refuses a hash whose settings are not sound, or would need too much memory', async () => {
    const key = randomBytes(64).toString('base64');
    const salt = randomBytes(16).toString('base64');
    for (const [n, r, p] of [
      [2 ** 30, 8, 1], // 1 TB to check
      [2 ** 22, 8, 1], // 4 GB
      [16385, 8, 1], // not a power of two
      [0, 8, 1],
      [16384, 0, 1],
      [16384, 8, 0],
      [16384.5, 8, 1],
    ]) {
      const stored = ['scrypt', n, r, p, salt, key].join('$');
      await expect(verifyPassword('x', stored)).resolves.toBe(false);
      expect(needsRehash(stored)).toBe(false);
    }
  });
});

describe('needsRehash: moving to stronger settings', () => {
  it('is false for a hash made now', async () => {
    expect(needsRehash(await hashPassword('x'))).toBe(false);
  });

  it('is true for a hash made with the earlier, weaker settings, which still verifies', async () => {
    const old = await hashWith('old password', 16384, 8, 1);
    expect(needsRehash(old)).toBe(true);
    await expect(verifyPassword('old password', old)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', old)).resolves.toBe(false);
  });

  it('is true when N or r is weaker, including the equivalent settings that cost less memory', async () => {
    expect(needsRehash(await hashWith('x', 65536, 8, 1))).toBe(true); // N
    expect(needsRehash(await hashWith('x', 32768, 8, 3))).toBe(true); // N, p higher
    expect(needsRehash(await hashWith('x', 131072, 4, 1))).toBe(true); // r
  });

  it('is false for a stronger hash, and for what is not a hash of ours', async () => {
    expect(needsRehash(await hashWith('x', 131072, 8, 2))).toBe(false);
    for (const stored of ['plain-text', '', 'bcrypt$x$y$z$a$b']) {
      expect(needsRehash(stored)).toBe(false);
    }
  });
});
