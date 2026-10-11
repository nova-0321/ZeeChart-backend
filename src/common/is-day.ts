import { ValidateBy, type ValidationOptions } from 'class-validator';

/** The years a date may be in: enough for any plan, and inside what every part of the app handles. */
export const FIRST_YEAR = 1900;
export const LAST_YEAR = 9998;

/** Whether `value` is a day that exists ("2026-02-30" does not), in FIRST_YEAR..LAST_YEAR. */
export function isDay(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < FIRST_YEAR || year > LAST_YEAR) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * A date ("2026-10-12", or with a time) that exists, between FIRST_YEAR and LAST_YEAR.
 * `@IsDateString()` takes "2026-02-30" (the database then refuses it, or it rolls over to March).
 */
export const IsDay = (options?: ValidationOptions) =>
  ValidateBy(
    {
      name: 'isDay',
      validator: {
        validate: isDay,
        defaultMessage: (args) =>
          `${args?.property ?? 'date'} must be a real date between ${FIRST_YEAR} and ${LAST_YEAR}, like 2026-10-12`,
      },
    },
    options,
  );
