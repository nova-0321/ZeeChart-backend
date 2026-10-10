import { hashPassword, verifyPassword } from './password.js';

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
    expect(a.startsWith('scrypt$16384$8$1$')).toBe(true);
  });

  it('refuses anything that is not one of its hashes', async () => {
    for (const stored of ['plain-text', '', 'scrypt$16384$8$1$$', 'bcrypt$x$y$z$a$b']) {
      await expect(verifyPassword('x', stored)).resolves.toBe(false);
    }
  });
});
