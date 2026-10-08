import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateEventDto } from './create-event.dto.js';

/** Every field is optional and validated like on create. The project of an event never changes. */
export class UpdateEventDto extends PartialType(OmitType(CreateEventDto, ['projectId'] as const)) {}
