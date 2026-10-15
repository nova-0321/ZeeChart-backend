import type { EntityManager } from 'typeorm';
import { User } from './entities/user.entity.js';

/**
 * The name an account shows to others; null when the account is gone. For code that runs in a
 * transaction (the conflict check, #21): it reads on the caller's manager. Other domains read
 * accounts here or through AuthService, never from the users table (#55).
 */
export async function accountNameOf(manager: EntityManager, id: string): Promise<string | null> {
  const user = await manager.findOne(User, { select: { name: true }, where: { id } });
  return user?.name ?? null;
}
