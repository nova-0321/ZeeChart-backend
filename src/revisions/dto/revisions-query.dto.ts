import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class RevisionsQueryDto {
  /** The id of the last revision of the previous page: the next page goes on after it. */
  @IsOptional()
  @IsUUID()
  before?: string;

  /** How many: 50 when left out, at most 100. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
