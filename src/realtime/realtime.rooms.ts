/** The room of the people who have a project open. */
export const projectRoom = (projectId: string) => `project:${projectId}`;

export const isProjectRoom = (room: string) => room.startsWith('project:');

/**
 * One room per browser tab (its client id), so a change can skip the tab that made it. Under its
 * user: a tab id copied from someone else (presence shows them) names a room of the copier's own,
 * so it can't keep that person from hearing of a change.
 */
export const clientRoom = (userId: string, clientId: string) => `client:${userId}:${clientId}`;

/** The project of a project room (see projectRoom). */
export const projectOfRoom = (room: string) => room.slice('project:'.length);

/** One room per signed-in user (all their tabs), told about their own memberships. */
export const userRoom = (userId: string) => `user:${userId}`;
