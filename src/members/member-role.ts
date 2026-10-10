/**
 * What a member may do in a project; each role can do everything the ones below it can.
 * - viewer: see the project and everything in it.
 * - editor: also change its tasks, links and events.
 * - owner: also rename, archive, reopen or delete it, and add, change or remove members.
 */
export const MEMBER_ROLES = ['owner', 'editor', 'viewer'] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];

const RANK: Record<MemberRole, number> = { viewer: 0, editor: 1, owner: 2 };

/** Whether `role` may do what `needed` may. */
export const roleCovers = (role: MemberRole, needed: MemberRole) => RANK[role] >= RANK[needed];
