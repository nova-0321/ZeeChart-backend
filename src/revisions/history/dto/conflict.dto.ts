import { ApiProperty } from '@nestjs/swagger';
import { ErrorDto } from '../../../common/dto/error.dto.js';

/** Who made the change a write ran into. */
export class ConflictAuthorDto {
  id: string;
  name: string;
}

/** What a refused write ran into (#21): see docs/conflicts.md. */
export class ConflictDetailsDto {
  @ApiProperty({ enum: [true] })
  conflict: true;

  /** The fields someone else changed since the version the write was made from. */
  fields: string[];

  /** Who changed them; null when that account is gone. */
  changedBy: ConflictAuthorDto | null;

  /** The row as it is now; null when it was deleted. */
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  current: Record<string, unknown> | null;

  /** Its version now: send it as `If-Match` to save over it. */
  version: number | null;
}

/** The 409 a write answers when someone else changed the same fields since (If-Match). */
export class ConflictErrorDto extends ErrorDto {
  details: ConflictDetailsDto;
}
