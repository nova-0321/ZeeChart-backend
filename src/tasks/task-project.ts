import { projectOfRow, type ProjectLocator } from '../projects/project-access.js';
import { Task } from './entities/task.entity.js';

/**
 * The project of the task whose id is in route parameter `key` (or, with `from: 'body'`, in that
 * field of the body). For other domains' routes about a task (a new link): they find its project
 * here, not through the Task entity.
 */
export const projectOfTask = (key = 'id', from: 'param' | 'body' = 'param'): ProjectLocator =>
  projectOfRow(Task, key, from);
