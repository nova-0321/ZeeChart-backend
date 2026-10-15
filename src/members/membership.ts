import { type DataSource, type EntityManager, Like, Not } from 'typeorm';
import { Member } from './entities/member.entity.js';
import type { MemberRole } from './member-role.js';

// Memberships as other domains need them: the access checks, and the projects domain (a new
// project's first owner, "my projects", the name rule among the projects one owns). They come
// here, not to the members table (#55). Each takes the caller's manager (or the data source), so it
// runs in that transaction, on its connection.

/** Makes `userId` the first owner of a project just created. */
export const addOwner = (manager: EntityManager, projectId: string, userId: string) =>
  manager.save(manager.create(Member, { projectId, userId, role: 'owner' }));

/** `userId`'s memberships, each with its project and who added them; the newest project first. */
export const membershipsOf = (manager: EntityManager, userId: string) =>
  manager.find(Member, {
    where: { userId },
    relations: { project: true, addedBy: true },
    order: { project: { createdAt: 'DESC' } },
  });

/** `userId`'s membership of one project, with the project and who added them; null if none. */
export const membershipOf = (manager: EntityManager, projectId: string, userId: string) =>
  manager.findOne(Member, {
    where: { projectId, userId },
    relations: { project: true, addedBy: true },
  });

/** The project's owners (user ids), in a fixed order. */
export const ownerIdsOf = async (manager: EntityManager, projectId: string): Promise<string[]> =>
  (
    await manager.find(Member, {
      select: { userId: true },
      where: { projectId, role: 'owner' },
      order: { userId: 'ASC' },
    })
  ).map((owner) => owner.userId);

/** Whether `userId` owns a project called `name` (other than `exceptId`). */
export const ownsProjectNamed = (
  manager: EntityManager,
  userId: string,
  name: string,
  exceptId?: string,
) =>
  manager.exists(Member, {
    where: {
      userId,
      role: 'owner',
      project: { name, ...(exceptId ? { id: Not(exceptId) } : {}) },
    },
    relations: { project: true },
  });

/**
 * Someone's role in a project, or null when they are not a member. Other domains ask here (the
 * access guard on nearly every route, the live connection, undo), not the members table (#55).
 * Pass the transaction's manager when there is one, so it reads on that connection.
 */
export const roleIn = async (
  db: DataSource | EntityManager,
  projectId: string,
  userId: string,
): Promise<MemberRole | null> => {
  const member = await db
    .getRepository(Member)
    .findOne({ select: { role: true }, where: { projectId, userId } });
  return member?.role ?? null;
};

/** Whether an owner of the project owns another project called `name` (undo of a rename). */
export const ownersOwnProjectNamed = async (
  manager: EntityManager,
  projectId: string,
  name: string,
): Promise<boolean> => {
  for (const ownerId of await ownerIdsOf(manager, projectId)) {
    if (await ownsProjectNamed(manager, ownerId, name, projectId)) return true;
  }
  return false;
};

/**
 * The names of the projects `userId` owns that are `base` or start with `base ` (copying a version
 * picks the first free one of "base", "base 2"...).
 */
export const ownedNamesLike = async (
  manager: EntityManager,
  userId: string,
  base: string,
): Promise<string[]> =>
  (
    await manager.find(Member, {
      where: [
        { userId, role: 'owner', project: { name: base } },
        { userId, role: 'owner', project: { name: Like(`${base} %`) } },
      ],
      relations: { project: true },
    })
  ).map((member) => member.project.name);
