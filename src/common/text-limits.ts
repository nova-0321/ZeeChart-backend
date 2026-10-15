/**
 * The longest description (notes) a project or task may have, in characters (#59): far more than a
 * note needs, small enough that one request can't fill the database. The column is `text`, so the
 * limit is only here, where every create and update is checked.
 */
export const DESCRIPTION_MAX_LENGTH = 5000;
