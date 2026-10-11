// What changed in a project between two snapshots (before and after one request), as revisions:
// one per project, task or event that changed, with its state before and after and a sentence a
// person can read ("Renamed “A” to “B”; dates Oct 1–5 → Oct 3–7"). Pure: no database here (see
// revision-state.ts for the snapshots and revisions.service.ts for saving them).

export const REVISION_ENTITIES = ['project', 'task', 'event', 'link'] as const;
export type RevisionEntity = (typeof REVISION_ENTITIES)[number];

export const REVISION_ACTIONS = ['create', 'update', 'delete'] as const;
export type RevisionAction = (typeof REVISION_ACTIONS)[number];

export interface ProjectState {
  id: string;
  name: string;
  description: string | null;
  archived: boolean;
}

/** A link between two tasks (also kept with a deleted task, to bring it back with it). */
export interface LinkState {
  /** Absent in versions saved before links had their own history. */
  id?: string;
  fromTaskId: string;
  toTaskId: string;
  type: string;
  lagDays: number;
}

export interface TaskState {
  id: string;
  name: string;
  description: string | null;
  type: string;
  priority: string;
  /** "YYYY-MM-DD". */
  startDate: string;
  endDate: string;
  progress: number;
  color: string;
  order: number;
  parentId: string | null;
  /** Only on a deleted task's last state: the links that went with it. */
  links?: LinkState[];
}

export interface EventState {
  id: string;
  name: string;
  color: string;
  startDate: string;
  endDate: string;
}

/** A whole project at one moment. */
export interface Snapshot {
  project: ProjectState | null;
  tasks: Map<string, TaskState>;
  events: Map<string, EventState>;
  links: LinkState[];
}

export type EntityState = ProjectState | TaskState | EventState | LinkState;

export interface RevisionDraft {
  /** The change the request was about; the others in the batch happened because of it. */
  primary?: boolean;
  entityType: RevisionEntity;
  entityId: string;
  action: RevisionAction;
  /** null for a create. */
  before: EntityState | null;
  /** null for a delete. */
  after: EntityState | null;
  summary: string;
}

export const TASK_FIELDS = [
  'name',
  'description',
  'type',
  'priority',
  'startDate',
  'endDate',
  'progress',
  'color',
  'parentId',
] as const;
export const EVENT_FIELDS = ['name', 'color', 'startDate', 'endDate'] as const;
export const PROJECT_FIELDS = ['name', 'description', 'archived'] as const;
export const LINK_FIELDS = ['fromTaskId', 'toTaskId', 'type', 'lagDays'] as const;

const changed = <T extends object>(before: T, after: T, fields: readonly (keyof T)[]) =>
  fields.filter((field) => before[field] !== after[field]);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Oct 3" (the year only when the two ends differ in it, see span). */
const shortDay = (iso: string, withYear = false) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}${withYear ? `, ${y}` : ''}`;
};
/** "Oct 3–7", "Oct 30–Nov 2", "Oct 3" for one day. */
export const span = (start: string, end: string) => {
  if (start === end) return shortDay(start);
  const withYear = start.slice(0, 4) !== end.slice(0, 4);
  const [sm, em] = [start.slice(5, 7), end.slice(5, 7)];
  if (!withYear && sm === em) return `${shortDay(start)}–${Number(end.slice(8, 10))}`;
  return `${shortDay(start, withYear)}–${shortDay(end, withYear)}`;
};

const quote = (name: string) => `“${name}”`;

function taskSentence(
  before: TaskState,
  after: TaskState,
  fields: readonly string[],
  nameOf: (id: string) => string | undefined,
): string {
  const parts: string[] = [];
  if (fields.includes('name')) parts.push(`renamed ${quote(before.name)} to ${quote(after.name)}`);
  if (fields.includes('startDate') || fields.includes('endDate')) {
    parts.push(
      `dates ${span(before.startDate, before.endDate)} → ${span(after.startDate, after.endDate)}`,
    );
  }
  if (fields.includes('progress')) parts.push(`progress ${before.progress}% → ${after.progress}%`);
  if (fields.includes('priority')) parts.push(`priority ${before.priority} → ${after.priority}`);
  if (fields.includes('type')) parts.push(`now a ${after.type}`);
  if (fields.includes('color')) parts.push('color changed');
  if (fields.includes('description')) parts.push('description edited');
  if (fields.includes('parentId')) {
    const group = after.parentId ? nameOf(after.parentId) : undefined;
    parts.push(
      after.parentId ? `moved into ${group ? quote(group) : 'a group'}` : 'moved out of its group',
    );
  }
  if (parts.length === 0) parts.push('moved in the list');
  const subject = fields.includes('name') ? '' : `${quote(after.name)}: `;
  const text = parts.join('; ');
  return subject + text.charAt(0).toUpperCase() + text.slice(1);
}

function eventSentence(before: EventState, after: EventState, fields: readonly string[]): string {
  const parts: string[] = [];
  if (fields.includes('name')) parts.push(`renamed ${quote(before.name)} to ${quote(after.name)}`);
  if (fields.includes('startDate') || fields.includes('endDate')) {
    parts.push(
      `dates ${span(before.startDate, before.endDate)} → ${span(after.startDate, after.endDate)}`,
    );
  }
  if (fields.includes('color')) parts.push('color changed');
  const subject = fields.includes('name') ? 'Event ' : `Event ${quote(after.name)}: `;
  return subject + parts.join('; ');
}

function projectSentence(
  before: ProjectState,
  after: ProjectState,
  fields: readonly string[],
): string {
  const parts: string[] = [];
  if (fields.includes('name')) parts.push(`renamed ${quote(before.name)} to ${quote(after.name)}`);
  if (fields.includes('archived')) parts.push(after.archived ? 'archived' : 'reopened');
  if (fields.includes('description')) parts.push('description edited');
  const text = `Project ${parts.join('; ')}`;
  return text;
}

/**
 * The revisions between two snapshots of one project. `target`: the row the request was about;
 * a change of only its place in the list (`order`) is recorded for it alone, not for the rows
 * renumbered around it.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot, target?: string): RevisionDraft[] {
  const drafts: RevisionDraft[] = [];
  // Names of tasks, now or before (a group that was deleted in the same request).
  const nameOf = (id: string) => after.tasks.get(id)?.name ?? before.tasks.get(id)?.name;

  if (before.project && after.project) {
    const fields = changed(before.project, after.project, PROJECT_FIELDS);
    if (fields.length > 0) {
      drafts.push({
        entityType: 'project',
        entityId: after.project.id,
        action: 'update',
        before: before.project,
        after: after.project,
        summary: projectSentence(before.project, after.project, fields),
      });
    }
  }

  for (const [id, now] of after.tasks) {
    const was = before.tasks.get(id);
    if (!was) {
      const group = now.parentId ? nameOf(now.parentId) : undefined;
      drafts.push({
        entityType: 'task',
        entityId: id,
        action: 'create',
        before: null,
        after: now,
        summary: `Added ${now.type} ${quote(now.name)}${group ? ` in ${quote(group)}` : ''}`,
      });
      continue;
    }
    const fields: string[] = changed(was, now, TASK_FIELDS);
    if (fields.length === 0 && !(id === target && was.order !== now.order)) continue;
    drafts.push({
      entityType: 'task',
      entityId: id,
      action: 'update',
      before: was,
      after: now,
      summary: taskSentence(was, now, fields, nameOf),
    });
  }
  for (const [id, was] of before.tasks) {
    if (after.tasks.has(id)) continue;
    const links = before.links.filter((link) => link.fromTaskId === id || link.toTaskId === id);
    drafts.push({
      entityType: 'task',
      entityId: id,
      action: 'delete',
      before: { ...was, links },
      after: null,
      summary: `Deleted ${was.type} ${quote(was.name)}`,
    });
  }

  for (const [id, now] of after.events) {
    const was = before.events.get(id);
    if (!was) {
      drafts.push({
        entityType: 'event',
        entityId: id,
        action: 'create',
        before: null,
        after: now,
        summary: `Added event ${quote(now.name)} (${span(now.startDate, now.endDate)})`,
      });
      continue;
    }
    const fields = changed(was, now, EVENT_FIELDS);
    if (fields.length === 0) continue;
    drafts.push({
      entityType: 'event',
      entityId: id,
      action: 'update',
      before: was,
      after: now,
      summary: eventSentence(was, now, fields),
    });
  }
  for (const [id, was] of before.events) {
    if (after.events.has(id)) continue;
    drafts.push({
      entityType: 'event',
      entityId: id,
      action: 'delete',
      before: was,
      after: null,
      summary: `Deleted event ${quote(was.name)}`,
    });
  }
  // Links, by id. A link that went with a deleted task is recorded too (its task keeps it as well).
  const linkName = (link: LinkState) =>
    `${quote(nameOf(link.fromTaskId) ?? 'a task')} → ${quote(nameOf(link.toTaskId) ?? 'a task')}`;
  const linksBefore = new Map(
    before.links.flatMap((link): [string, LinkState][] => (link.id ? [[link.id, link]] : [])),
  );
  for (const link of after.links) {
    if (!link.id) continue;
    const was = linksBefore.get(link.id);
    if (!was) {
      drafts.push({
        entityType: 'link',
        entityId: link.id,
        action: 'create',
        before: null,
        after: link,
        summary: `Linked ${linkName(link)}`,
      });
      continue;
    }
    if (was.type === link.type && was.lagDays === link.lagDays) continue;
    const parts = [
      ...(was.type !== link.type ? [`type ${was.type} → ${link.type}`] : []),
      ...(was.lagDays !== link.lagDays ? [`lag ${was.lagDays} → ${link.lagDays} days`] : []),
    ];
    drafts.push({
      entityType: 'link',
      entityId: link.id,
      action: 'update',
      before: was,
      after: link,
      summary: `Link ${linkName(link)}: ${parts.join('; ')}`,
    });
  }
  const linksAfter = new Set(after.links.map((link) => link.id));
  for (const [id, was] of linksBefore) {
    if (linksAfter.has(id)) continue;
    drafts.push({
      entityType: 'link',
      entityId: id,
      action: 'delete',
      before: was,
      after: null,
      summary: `Unlinked ${linkName(was)}`,
    });
  }
  // The main change: the request's own row; else what it made or removed (a new task, which the
  // request didn't name yet); else the first.
  const main =
    drafts.find((draft) => draft.entityId === target) ??
    drafts.find((draft) => draft.action !== 'update') ??
    drafts[0];
  if (main) main.primary = true;
  return drafts;
}

/** The state a revision brings back: after it, or, for a delete, just before it. */
export const stateOf = (revision: { action: RevisionAction; before: unknown; after: unknown }) =>
  (revision.action === 'delete' ? revision.before : revision.after) as EntityState | null;
