// The allowed values for the task enums. The entity columns, the DTOs and the OpenAPI
// contract all use these, and the frontend mirrors them. (The link constants are in
// dependencies/dependency.constants.ts.)
export const TASK_TYPES = ['group', 'task', 'milestone'] as const;
export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;

export type TaskType = (typeof TASK_TYPES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
