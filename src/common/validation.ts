import { ValidationPipe } from '@nestjs/common';

/**
 * How every request body and query is checked: against its DTO, with values turned into their
 * types (transform). A field the DTO doesn't have is refused (400, "property x should not exist")
 * rather than quietly dropped, so a mistake or an outdated client is told instead of getting a
 * success that changed nothing. Used by main.ts and the e2e tests alike, so tests run what runs.
 */
export const createValidationPipe = () =>
  new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
