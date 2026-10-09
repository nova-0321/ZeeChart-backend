// How a dependency ties two tasks: the first letter is the end of the predecessor, the second the
// end of the successor. FS = the successor starts after the predecessor finishes (the usual one).
// The DTOs and the OpenAPI contract use these, and the frontend mirrors them.
export const DEPENDENCY_TYPES = ['FS', 'SS', 'FF', 'SF'] as const;

/** The longest lag or lead of a link, in days. */
export const MAX_LAG_DAYS = 365;

export type DependencyType = (typeof DEPENDENCY_TYPES)[number];
