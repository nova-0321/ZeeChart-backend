// The allowed values for the task enums. The entity columns, the DTOs and the OpenAPI
// contract all use these, and the frontend mirrors them.
export const TASK_TYPES = ['group', 'task', 'milestone'] as const;
export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;

// How a dependency ties two tasks: the first letter is the end of the predecessor, the second the
// end of the successor. FS = the successor starts after the predecessor finishes (the usual one).
export const DEPENDENCY_TYPES = ['FS', 'SS', 'FF', 'SF'] as const;

/** The longest lag or lead of a link, in days. */
export const MAX_LAG_DAYS = 365;

export type DependencyType = (typeof DEPENDENCY_TYPES)[number];
export type TaskType = (typeof TASK_TYPES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
