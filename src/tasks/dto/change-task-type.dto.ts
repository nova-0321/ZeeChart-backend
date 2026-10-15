import { IsIn } from 'class-validator';
import { TASK_TYPES, type TaskType } from '../tasks.constants.js';

export class ChangeTaskTypeDto {
  @IsIn(TASK_TYPES)
  type: TaskType;
}
