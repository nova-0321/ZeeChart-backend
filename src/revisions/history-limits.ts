// How much history a project keeps (#54). Everything else is let go now and then
// (RevisionsService.prune, VersionsService.save), so it doesn't grow without limit.

/** How far back the undo / redo stacks are read: batches of one person in one project. */
export const UNDO_DEPTH = 200;

/** Revisions newer than this are kept: an open tab may still save from a version they made (#21). */
export const KEEP_REVISION_DAYS = 30;

/** Versions saved by hand kept per project, besides starred ones: the oldest go first. */
export const KEEP_MANUAL_VERSIONS = 50;

/** Versions that may be starred in a project at once. */
export const MAX_STARRED_VERSIONS = 20;

/** "Save a version now" per address per minute. */
export const SAVE_VERSION_LIMIT = 10;
