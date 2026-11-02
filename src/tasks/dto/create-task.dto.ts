import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DESCRIPTION_MAX_LENGTH } from '../../common/text-limits.js';
import { IsDay } from '../../common/is-day.js';
import {
  TASK_PRIORITIES,
  TASK_TYPES,
  type TaskPriority,
  type TaskType,
} from '../tasks.constants.js';

export class CreateTaskDto {
  // Trimmed before validation, so a name of only spaces is rejected as empty.
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(DESCRIPTION_MAX_LENGTH)
  description?: string;

  /** Defaults to "task". */
  @IsOptional()
  @IsIn(TASK_TYPES)
  type?: TaskType;

  /** "YYYY-MM-DD" (a full ISO date-time is accepted too). */
  @IsDay()
  startDate: Date;

  /** "YYYY-MM-DD". Must not be before startDate. */
  @IsDay()
  endDate: Date;

  /**
   * 0 to 100. Defaults to 0. Not for a group: a group's progress is the average of its tasks, kept
   * by the server (#80), and one sent for a group is refused (400).
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number;

  /** Defaults to "medium". */
  @IsOptional()
  @IsIn(TASK_PRIORITIES)
  priority?: TaskPriority;

  /** A hex color such as "#2a78d6". */
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be a hex color like #2a78d6' })
  color: string;

  /**
   * Its place in its level (the group's tasks, or the top level): 1 first, the tasks from there
   * moved down. Past the end, or none: the last. Every level is numbered 1, 2, 3... (#57).
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  order?: number;

  @IsUUID()
  projectId: string;

  /** The group this task belongs to. Leave out (or null) for a top-level task. */
  @IsOptional()
  @IsUUID()
  parentId?: string | null;
}
