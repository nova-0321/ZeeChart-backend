import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateTaskDto } from './create-task.dto.js';

/**
 * Every field is optional; what is sent is validated like on create. The project never changes,
 * and the parent and the type have their own endpoints (they carry extra rules), as does order.
 */
export class UpdateTaskDto extends PartialType(
  OmitType(CreateTaskDto, ['projectId', 'parentId', 'type', 'order'] as const),
) {}
