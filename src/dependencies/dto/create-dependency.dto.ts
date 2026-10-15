import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { DEPENDENCY_TYPES, MAX_LAG_DAYS, type DependencyType } from '../dependencies.constants.js';

export class CreateDependencyDto {
  /** The predecessor task. */
  @IsUUID()
  fromTaskId: string;

  /** The successor task: it comes after the predecessor. */
  @IsUUID()
  toTaskId: string;

  /** Defaults to "FS" (finish to start). */
  @IsOptional()
  @IsIn(DEPENDENCY_TYPES)
  type?: DependencyType;

  /** Days the successor waits after the predecessor; negative lets them overlap. Defaults to 0. */
  @ApiPropertyOptional({ minimum: -MAX_LAG_DAYS, maximum: MAX_LAG_DAYS })
  @IsOptional()
  @IsInt()
  @Min(-MAX_LAG_DAYS)
  @Max(MAX_LAG_DAYS)
  lagDays?: number;
}
