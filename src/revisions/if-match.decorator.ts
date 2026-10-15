import { applyDecorators } from '@nestjs/common';
import { ApiConflictResponse, ApiHeader } from '@nestjs/swagger';
import { ConflictErrorDto } from './history/dto/conflict.dto.js';

/**
 * Marks a write that is checked for conflicts (#21; RevisionInterceptor): it takes the version the
 * client saw as `If-Match`, and answers 409 with a ConflictErrorDto when someone else changed the
 * same fields since. Put on every such route, so the API docs say so (#59).
 */
export const IfMatch = () =>
  applyDecorators(
    ApiHeader({
      name: 'If-Match',
      required: false,
      description:
        'The version of the row this change was made from (as the API last gave it). Without it, nothing is checked.',
    }),
    ApiConflictResponse({
      type: ConflictErrorDto,
      description: 'Someone else changed the same fields since that version: nothing was saved',
    }),
  );
