/**
 * The longest description (notes) a project or task may have, in characters (#59): far more than a
 * note needs, small enough that one request can't fill the database. The column is `text`, so the
 * limit is only here, where every create and update is checked.
 */
export const DESCRIPTION_MAX_LENGTH = 5000;

/**
 * The longest task name, in characters (#81): longer names don't fit on the chart's bars or in the
 * task list. Checked only when a name is set or changed, so tasks named before the limit keep
 * their names and still save when an edit doesn't send the name.
 */
export const TASK_NAME_MAX_LENGTH = 40;
