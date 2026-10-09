import { Transform } from 'class-transformer';
import { IsDateString, IsNotEmpty, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CreateEventDto {
  // Trimmed before validation, so a name of only spaces is rejected as empty.
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  /** A hex color such as "#e5484d". */
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be a hex color like #e5484d' })
  color: string;

  /** "YYYY-MM-DD": the first day. */
  @IsDateString()
  startDate: string;

  /** "YYYY-MM-DD": the last day. Must not be before startDate. */
  @IsDateString()
  endDate: string;

  @IsUUID()
  projectId: string;
}
