import { OmitType, PartialType } from '@nestjs/swagger';
import { TaskDto } from './task.dto.js';

/**
 * Every field is optional; what is sent is validated like on create. The project never changes,
 * and the parent and the type have their own endpoints (they carry extra rules), as does order.
 */
export class UpdateTaskDto extends PartialType(
  OmitType(TaskDto, ['projectId', 'parentId', 'type', 'order'] as const),
) {}
