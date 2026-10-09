/** The room of the people who have a project open. */
export const projectRoom = (projectId: string) => `project:${projectId}`;

export const isProjectRoom = (room: string) => room.startsWith('project:');

/** One room per browser tab (its client id), so a change can skip the tab that made it. */
export const clientRoom = (clientId: string) => `client:${clientId}`;

/** The project of a project room (see projectRoom). */
export const projectOfRoom = (room: string) => room.slice('project:'.length);
