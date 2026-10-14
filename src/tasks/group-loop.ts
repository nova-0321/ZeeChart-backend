import { ConflictException } from '@nestjs/common';

/**
 * A project's groups that loop into each other (A inside B inside A): nothing writes one now, but
 * old data may hold one. A walk up the groups that meets a task twice refuses with this instead of
 * going round forever. Moving a task out to the top level walks nothing, so it still mends it.
 */
export const groupLoop = () =>
  new ConflictException(
    "This project's groups loop into each other. Move one of them out to the top level to fix it",
  );
