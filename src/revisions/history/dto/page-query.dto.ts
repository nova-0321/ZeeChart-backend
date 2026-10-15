import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** How many a page holds when `limit` is left out, and at most. */
export const PAGE_SIZE = 50;
export const MAX_PAGE = 100;

/** A page of a project's history or of its versions, newest first (keyset paging). */
export class PageQueryDto {
  /** The id of the last item of the previous page: the next page goes on after it. */
  @IsOptional()
  @IsUUID()
  before?: string;

  /** How many: 50 when left out, at most 100. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  limit?: number;
}
