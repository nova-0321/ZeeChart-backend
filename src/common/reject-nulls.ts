import { BadRequestException } from '@nestjs/common';

/**
 * An update DTO makes every field optional, and "optional" also lets null through the validators.
 * For a field that cannot be empty, null would reach the dates and the database and end as a 500.
 * Say so with a 400 instead. `allowed` lists the fields where null means "clear it".
 */
export function rejectNulls(dto: object, allowed: readonly string[] = []) {
  for (const [key, value] of Object.entries(dto)) {
    if (value === null && !allowed.includes(key)) {
      throw new BadRequestException(`${key} must not be null`);
    }
  }
}
