import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateDependencyDto } from './create-dependency.dto.js';

/** Change the type and/or the lag of a link; the two tasks of a link cannot change. */
export class UpdateDependencyDto extends PartialType(
  OmitType(CreateDependencyDto, ['fromTaskId', 'toTaskId'] as const),
) {}
