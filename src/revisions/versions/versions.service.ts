import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { RequestTransaction } from '../../database/request-transaction.js';
import type { MyProjectDto } from '../../projects/dto/my-project.dto.js';
import { roleIn } from '../../members/membership.js';
import { assertNameFree, ProjectsService } from '../../projects/projects.service.js';
import { MAX_PAGE, PAGE_SIZE } from '../history/dto/page-query.dto.js';
import { asVersionDto, type VersionDto, type VersionSummaryDto } from './dto/version.dto.js';
import { ProjectVersion, type VersionKind } from '../entities/project-version.entity.js';
import { KEEP_MANUAL_VERSIONS, MAX_STARRED_VERSIONS } from '../history-limits.js';
import type { Snapshot } from '../history/revision-diff.js';
import { loadSnapshot } from '../revision-state.js';
import { contentOf, sameContent, type VersionContent } from './version-content.js';
// Each kind of row is written back by the domain that owns it (#55).
import { deleteLinksOf, writeLink } from '../../dependencies/link-rows.js';
import { deleteEventsExcept, writeEvent } from '../../events/event-rows.js';
import { ownedNamesLike, ownerIdsOf } from '../../members/membership.js';
import { writeProjectFields } from '../../projects/project-rows.js';
import {
  deleteTasksExcept,
  fitGroupProgress,
  numberAllLevels,
  setTaskParent,
  writeTask,
} from '../../tasks/task-rows.js';
import { notFound } from '../../common/not-found.js';

/** An auto version is saved after a change when the newest version is older than this. */
export const AUTO_EVERY_MS = 10 * 60 * 1000;

/** Besides starred and manually saved ones, this many of the newest versions are kept. */
export const KEEP_RECENT = 30;

/**
 * Versions of a whole project (see ProjectVersion): saved by themselves while people edit, or by
 * hand, and restored as a whole. A restore first keeps the state it replaces as a version, so it
 * can be undone.
 */
@Injectable()
export class VersionsService {
  constructor(
    private readonly tx: RequestTransaction,
    private readonly projects: ProjectsService,
  ) {}

  private get versionRepo() {
    return this.tx.repo(ProjectVersion);
  }

  /**
   * The project's versions, newest first, without their contents (but how much is in each): a page
   * of `limit` (see PageQueryDto). `before`: the id of the last version of the previous page; the
   * page goes on with the older ones (versions are numbered, so the number is the cursor).
   */
  async list(projectId: string, before?: string, limit = PAGE_SIZE): Promise<VersionSummaryDto[]> {
    const query = this.versionRepo
      .createQueryBuilder('version')
      .leftJoin('version.createdBy', 'createdBy')
      .select([
        'version.id AS "id"',
        'version.number AS "number"',
        'version.kind AS "kind"',
        'version.starred AS "starred"',
        'version.createdAt AS "createdAt"',
        'createdBy.id AS "createdById"',
        'createdBy.name AS "createdByName"',
        `jsonb_array_length(version.content->'tasks') AS "tasks"`,
        `jsonb_array_length(version.content->'events') AS "events"`,
      ])
      .where('version.projectId = :projectId', { projectId })
      .orderBy('version.number', 'DESC')
      .limit(Math.min(Math.max(limit, 1), MAX_PAGE));
    if (before) {
      query.andWhere(
        `version.number < (
           SELECT cursor."number" FROM "project_versions" cursor
            WHERE cursor."id" = :before AND cursor."projectId" = :projectId)`,
        { before },
      );
    }
    const rows = await query.getRawMany<{
      id: string;
      number: number;
      kind: VersionKind;
      starred: boolean;
      createdAt: Date;
      createdById: string | null;
      createdByName: string | null;
      tasks: number;
      events: number;
    }>();
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      kind: row.kind,
      starred: row.starred,
      createdAt: row.createdAt,
      createdBy: row.createdById ? { id: row.createdById, name: row.createdByName ?? '' } : null,
      tasks: Number(row.tasks),
      events: Number(row.events),
    }));
  }

  /** One version with what is in it (to look at). */
  async get(id: string): Promise<VersionDto> {
    const version = await this.versionRepo.findOne({
      where: { id },
      relations: { createdBy: true },
    });
    if (!version) throw notFound('Version');
    return asVersionDto(version);
  }

  /** Stars or unstars it. A star keeps a version for good, so only MAX_STARRED_VERSIONS at once. */
  async star(id: string, starred: boolean): Promise<VersionDto> {
    const version = await this.versionRepo.findOneBy({ id });
    if (!version) throw notFound('Version');
    if (starred && !version.starred) {
      const count = await this.versionRepo.countBy({ projectId: version.projectId, starred: true });
      if (count >= MAX_STARRED_VERSIONS) {
        throw new ConflictException(
          `A project can have ${MAX_STARRED_VERSIONS} starred versions at most. Unstar one first`,
        );
      }
    }
    await this.versionRepo.update({ id }, { starred });
    return this.get(id);
  }

  /**
   * "Save a version now": the project as it is, kept like every version saved by hand. When the
   * newest version already holds exactly this, that one is kept instead (marked as saved by hand,
   * so it isn't let go like an auto one): no second copy of the same project.
   */
  async saveNow(
    projectId: string,
    userId: string,
  ): Promise<{ version: VersionDto; created: boolean }> {
    const snapshot = await loadSnapshot(this.tx.manager, projectId);
    if (!snapshot.project) throw notFound('Project');
    const content = contentOf({ ...snapshot, project: snapshot.project });
    const latest = await this.versionRepo.findOne({
      where: { projectId },
      order: { number: 'DESC' },
    });
    if (latest && sameContent(latest.content, content)) {
      if (latest.kind !== 'manual') {
        await this.versionRepo.update({ id: latest.id }, { kind: 'manual' });
      }
      return { version: await this.get(latest.id), created: false };
    }
    const version = await this.save(projectId, 'manual', content, userId);
    return { version: await this.get(version.id), created: true };
  }

  /**
   * After a change (RevisionInterceptor gives the project as it is now): saved as an auto version
   * when the newest version is older than AUTO_EVERY_MS (or there is none), unless nothing differs
   * from it. Answers whether it saved one. Never throws for the caller: a version not saved only
   * means fewer to go back to.
   */
  async autoSave(projectId: string, after: Snapshot, userId: string | null): Promise<boolean> {
    if (!after.project) return false;
    // Its number, age and size first: the whole content is read only when a version is due.
    const [head] = await this.tx.manager.query<{ number: number; due: boolean; tasks: number }[]>(
      `SELECT "number", now() - "createdAt" >= make_interval(secs => $2) AS "due",
              jsonb_array_length("content"->'tasks')::int AS "tasks"
         FROM "project_versions" WHERE "projectId" = $1 ORDER BY "number" DESC LIMIT 1`,
      [projectId, AUTO_EVERY_MS / 1000],
    );
    // Not too often; but the first change of a new project is kept at once (its v1 is empty, so
    // otherwise the history would show nothing of the work for its first 10 minutes). The age is
    // worked out by the database (whatever time zone this server runs in).
    const fresh = head?.number === 1 && head.tasks === 0;
    if (head && !fresh && !head.due) return false;
    const content = contentOf({ ...after, project: after.project });
    const latest = head
      ? await this.versionRepo.findOne({ where: { projectId }, order: { number: 'DESC' } })
      : null;
    if (latest && sameContent(latest.content, content)) return false;
    await this.save(projectId, 'auto', content, userId);
    return true;
  }

  /**
   * Puts the whole project back as it was in the version: its tasks (with their ids, groups and
   * order), events and links; tasks and events made since are removed. The project's name and
   * description come back too for an owner (an editor can't rename the project). First the state
   * it replaces is saved as a `before-restore` version (unless the newest version already holds
   * it), so this can be undone; then the versions newer than the restored one go, except starred
   * and manually saved ones (and that one).
   */
  restore(id: string, userId: string): Promise<{ version: number; savedAs: number | null }> {
    return this.tx.run(() => this.restoreNow(id, userId));
  }

  private async restoreNow(
    id: string,
    userId: string,
  ): Promise<{ version: number; savedAs: number | null }> {
    const version = await this.versionRepo.findOneBy({ id });
    if (!version) throw notFound('Version');
    const { projectId, content } = version;

    const now = await loadSnapshot(this.tx.manager, projectId);
    if (!now.project) throw notFound('Project');
    const current = contentOf({ ...now, project: now.project });
    const latest = await this.versionRepo.findOne({
      where: { projectId },
      order: { number: 'DESC' },
    });
    const kept =
      latest && sameContent(latest.content, current)
        ? latest
        : await this.save(projectId, 'before-restore', current, userId);

    const owner = (await roleIn(this.tx.manager, projectId, userId)) === 'owner';
    await this.tx.manager.transaction(async (manager) => {
      await this.apply(manager, projectId, content, owner);
      await manager.query(
        `DELETE FROM "project_versions"
          WHERE "projectId" = $1 AND "number" > $2 AND "id" <> $3
            AND NOT "starred" AND "kind" <> 'manual'`,
        [projectId, version.number, kept.id],
      );
    });
    return { version: version.number, savedAs: kept === latest ? null : kept.number };
  }

  /**
   * A new project of yours, made from the version: its tasks, events and links (new ids), named
   * "<name> (v3)" (or "<name> (v3) 2"... when you have one by that name). The version's project is
   * not touched. Its own history starts with this content as v1. One transaction: if filling it
   * fails, no project is left.
   */
  copy(id: string, userId: string): Promise<MyProjectDto> {
    return this.tx.run(() => this.copyNow(id, userId));
  }

  private async copyNow(id: string, userId: string): Promise<MyProjectDto> {
    const version = await this.versionRepo.findOneBy({ id });
    if (!version) throw notFound('Version');
    const { content } = version;
    // Within the 255 characters a name may have, " (v12) 99" included.
    const suffix = ` (v${version.number})`;
    const base = content.project.name.slice(0, 255 - suffix.length - 4).trimEnd();
    const name = await this.freeName(userId, `${base}${suffix}`);
    const project = await this.projects.create(
      { name, description: content.project.description ?? undefined },
      userId,
    );
    const ids = new Map(content.tasks.map((task) => [task.id, randomUUID()]));
    await this.fill(project.id, content, ids);
    return project;
  }

  /** Copies a version's tasks, events and links into a new project (see `copy`), with new ids. */
  private async fill(projectId: string, content: VersionContent, ids: Map<string, string>) {
    const project = { id: projectId };
    await this.tx.manager.transaction(async (manager) => {
      for (const task of content.tasks) {
        await writeTask(manager, project.id, { ...task, id: ids.get(task.id)! });
      }
      for (const task of content.tasks) {
        if (task.parentId && ids.has(task.parentId)) {
          await setTaskParent(manager, ids.get(task.id)!, ids.get(task.parentId)!);
        }
      }
      await numberAllLevels(manager, project.id);
      // Its groups' progress as the average of its tasks (#80): a version from before has its own.
      await fitGroupProgress(manager, project.id);
      for (const event of content.events) {
        await writeEvent(manager, project.id, { ...event, id: randomUUID() });
      }
      for (const link of content.links) {
        const [from, to] = [ids.get(link.fromTaskId), ids.get(link.toTaskId)];
        if (from && to) {
          // A new link (a new id): the original stays with its own project.
          await writeLink(manager, project.id, {
            ...link,
            id: undefined,
            fromTaskId: from,
            toTaskId: to,
          });
        }
      }
      // Its v1 is what it was made from (not the empty project it was for a moment).
      const made = await loadSnapshot(manager, project.id);
      await manager.update(
        ProjectVersion,
        { projectId: project.id, number: 1 },
        { content: contentOf({ ...made, project: made.project! }) },
      );
    });
  }

  /** `base`, or `base 2`, `base 3`...: the first that none of the projects you own is called. */
  private async freeName(userId: string, base: string) {
    const taken = new Set(await ownedNamesLike(this.tx.manager, userId, base));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base} ${n}`)) n += 1;
    return `${base} ${n}`;
  }

  /** Writes a version's content over the project (inside the caller's transaction). */
  private async apply(
    manager: EntityManager,
    projectId: string,
    content: VersionContent,
    withProjectFields: boolean,
  ) {
    const taskIds = content.tasks.map((task) => task.id);
    const eventIds = content.events.map((event) => event.id);
    // Links first (they refer to tasks), then what the version doesn't have.
    await deleteLinksOf(manager, projectId);
    await deleteTasksExcept(manager, projectId, taskIds);
    await deleteEventsExcept(manager, projectId, eventIds);
    for (const task of content.tasks) await writeTask(manager, projectId, task);
    for (const task of content.tasks) {
      if (task.parentId) await setTaskParent(manager, task.id, task.parentId);
    }
    // Each level numbered 1, 2, 3... (a version saved before levels were kept so may have gaps).
    await numberAllLevels(manager, projectId);
    for (const event of content.events) await writeEvent(manager, projectId, event);
    for (const link of content.links) await writeLink(manager, projectId, link);
    if (withProjectFields) {
      // The name only when no owner of it owns another project of that name now (names are unique
      // among the projects one owns: see assertNameFree); otherwise it keeps the name it has.
      let nameFree = true;
      for (const ownerId of await ownerIdsOf(manager, projectId)) {
        try {
          await assertNameFree(manager, ownerId, content.project.name, projectId);
        } catch {
          nameFree = false;
        }
      }
      await writeProjectFields(manager, projectId, content.project, nameFree);
    }
  }

  /**
   * A new version, numbered after the project's last (a lock keeps two saves apart). Then the
   * oldest are let go: starred versions stay, and the KEEP_MANUAL_VERSIONS newest saved by hand and
   * the KEEP_RECENT newest of the others.
   */
  private save(
    projectId: string,
    kind: VersionKind,
    content: VersionContent,
    userId: string | null,
  ) {
    return this.tx.manager.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`versions:${projectId}`]);
      const [{ last }] = await manager.query<{ last: number | null }[]>(
        `SELECT MAX("number")::int AS "last" FROM "project_versions" WHERE "projectId" = $1`,
        [projectId],
      );
      const saved = await manager.save(
        manager.create(ProjectVersion, {
          projectId,
          number: (last ?? 0) + 1,
          kind,
          content,
          createdById: userId,
        }),
      );
      await manager.query(
        `DELETE FROM "project_versions" WHERE "id" IN (
           SELECT "id" FROM "project_versions"
            WHERE "projectId" = $1 AND NOT "starred" AND "kind" <> 'manual'
            ORDER BY "number" DESC OFFSET $2)`,
        [projectId, KEEP_RECENT],
      );
      await manager.query(
        `DELETE FROM "project_versions" WHERE "id" IN (
           SELECT "id" FROM "project_versions"
            WHERE "projectId" = $1 AND NOT "starred" AND "kind" = 'manual'
            ORDER BY "number" DESC OFFSET $2)`,
        [projectId, KEEP_MANUAL_VERSIONS],
      );
      return saved;
    });
  }
}
