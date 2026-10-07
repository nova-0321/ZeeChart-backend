import { IsIn } from 'class-validator';
import { TASK_TYPES, type TaskType } from '../task.constants.js';

export class ChangeTypeDto {
  @IsIn(TASK_TYPES)
  type: TaskType;
}
