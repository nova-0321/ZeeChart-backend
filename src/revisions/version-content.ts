import type { EventState, LinkState, ProjectState, Snapshot, TaskState } from './revision-diff.js';

/** A snapshot as a version keeps it (plain arrays, for JSON). */
export interface VersionContent {
  project: ProjectState;
  tasks: TaskState[];
  events: EventState[];
  links: LinkState[];
}

/** Rows in a fixed order, so the same project gives the same content (and can be compared). */
const byId = <T extends { id: string }>(rows: Iterable<T>) =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export function contentOf(snapshot: Snapshot & { project: ProjectState }): VersionContent {
  return {
    project: snapshot.project,
    tasks: byId(snapshot.tasks.values()),
    events: byId(snapshot.events.values()),
    links: [...snapshot.links].sort((a, b) =>
      `${a.fromTaskId}${a.toTaskId}` < `${b.fromTaskId}${b.toTaskId}` ? -1 : 1,
    ),
  };
}

/** JSON with every object's keys sorted: the same value gives the same text (jsonb reorders keys). */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  );

/** Whether two contents hold the same project state (the order of the list counts). */
export const sameContent = (a: VersionContent, b: VersionContent) => canonical(a) === canonical(b);
