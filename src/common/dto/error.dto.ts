import { ApiProperty } from '@nestjs/swagger';

/**
 * Every error the API answers has this shape (AllExceptionsFilter; see docs/conflicts.md). Clients
 * show `message`; `details` is there only when there is more to say (a conflict: ConflictErrorDto).
 */
export class ErrorDto {
  /** The HTTP status, again. */
  statusCode: number;

  /** The status's name in capitals: "BAD_REQUEST", "NOT_FOUND", "CONFLICT"... */
  @ApiProperty({ example: 'NOT_FOUND' })
  error: string;

  /** What went wrong, for a person; a list for invalid input (one line per field). */
  @ApiProperty({ oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] })
  message: string | string[];

  /** The path that was called. */
  path: string;

  /** When it happened (ISO 8601). */
  timestamp: string;
}
