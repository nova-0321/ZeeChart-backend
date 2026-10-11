import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, Repository } from 'typeorm';
import type { MyProjectDto } from '../projects/dto/my-project.dto.js';
import { roleIn } from '../projects/project-access.js';
import { ProjectsService } from '../projects/projects.service.js';
import { asVersionDto, type VersionDto, type VersionSummaryDto } from './dto/version.dto.js';
import { ProjectVersion, type VersionKind } from './entities/project-version.entity.js';
import type { Snapshot } from './revision-diff.js';
import { loadSnapshot } from './revision-state.js';
import { setTaskParent, writeEvent, writeLink, writeTask } from './revision-write.js';
import { contentOf, sameContent, type VersionContent } from './version-content.js';

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
    @InjectRepository(ProjectVersion)
    private readonly versionRepo: Repository<ProjectVersion>,
    private readonly db: DataSource,
    private readonly projects: ProjectsService,
  ) {}

  /** The project's versions, newest first, without their contents (but how much is in each). */
  async list(projectId: string): Promise<VersionSummaryDto[]> {
    const rows = await this.versionRepo
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
      .getRawMany<{
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
    if (!version) throw new NotFoundException('Not found');
    return asVersionDto(version);
  }

  async star(id: string, starred: boolean): Promise<VersionDto> {
    const { affected } = await this.versionRepo.update({ id }, { starred });
    if (!affected) throw new NotFoundException('Not found');
    return this.get(id);
  }

  /** "Save a version now": the project as it is, even if no version differs from it yet. */
  async saveNow(projectId: string, userId: string): Promise<VersionDto> {
    const snapshot = await loadSnapshot(this.db.manager, projectId);
    if (!snapshot.project) throw new NotFoundException('Not found');
    const version = await this.save(
      projectId,
      'manual',
      contentOf({ ...snapshot, project: snapshot.project }),
      userId,
    );
    return this.get(version.id);
  }

  /**
   * After a change (RevisionInterceptor gives the project as it is now): saved as an auto version
   * when the newest version is older than AUTO_EVERY_MS (or there is none), unless nothing differs
   * from it. Never throws for the caller: a version not saved only means fewer to go back to.
   */
  async autoSave(projectId: string, after: Snapshot, userId: string | null): Promise<void> {
    if (!after.project) return;
    const latest = await this.versionRepo.findOne({
      where: { projectId },
      order: { number: 'DESC' },
    });
    // Not too often; but the first change of a new project is kept at once (its v1 is empty, so
    // otherwise the history would show nothing of the work for its first 10 minutes).
    const fresh = latest?.number === 1 && latest.content.tasks.length === 0;
    if (latest && !fresh && Date.now() - latest.createdAt.getTime() < AUTO_EVERY_MS) return;
    const content = contentOf({ ...after, project: after.project });
    if (latest && sameContent(latest.content, content)) return;
    await this.save(projectId, 'auto', content, userId);
  }

  /**
   * Puts the whole project back as it was in the version: its tasks (with their ids, groups and
   * order), events and links; tasks and events made since are removed. The project's name and
   * description come back too for an owner (an editor can't rename the project). First the state
   * it replaces is saved as a `before-restore` version (unless the newest version already holds
   * it), so this can be undone; then the versions newer than the restored one go, except starred
   * and manually saved ones (and that one).
   */
  async restore(id: string, userId: string): Promise<{ version: number; savedAs: number | null }> {
    const version = await this.versionRepo.findOneBy({ id });
    if (!version) throw new NotFoundException('Not found');
    const { projectId, content } = version;

    const now = await loadSnapshot(this.db.manager, projectId);
    if (!now.project) throw new NotFoundException('Not found');
    const current = contentOf({ ...now, project: now.project });
    const latest = await this.versionRepo.findOne({
      where: { projectId },
      order: { number: 'DESC' },
    });
    const kept =
      latest && sameContent(latest.content, current)
        ? latest
        : await this.save(projectId, 'before-restore', current, userId);

    const owner = (await roleIn(this.db, projectId, userId)) === 'owner';
    await this.db.transaction(async (manager) => {
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
   * not touched. Its own history starts with this content as v1.
   */
  async copy(id: string, userId: string): Promise<MyProjectDto> {
    const version = await this.versionRepo.findOneBy({ id });
    if (!version) throw new NotFoundException('Not found');
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
    await this.db.transaction(async (manager) => {
      for (const task of content.tasks) {
        await writeTask(manager, project.id, { ...task, id: ids.get(task.id)! });
      }
      for (const task of content.tasks) {
        if (task.parentId && ids.has(task.parentId)) {
          await setTaskParent(manager, ids.get(task.id)!, ids.get(task.parentId)!);
        }
      }
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
    return project;
  }

  /** `base`, or `base 2`, `base 3`...: the first that none of your projects is called. */
  private async freeName(userId: string, base: string) {
    const rows = await this.db.query<{ name: string }[]>(
      `SELECT p."name" FROM "projects" p JOIN "members" m ON m."projectId" = p."id"
        WHERE m."userId" = $1 AND (p."name" = $2 OR p."name" LIKE $3)`,
      [userId, base, `${base} %`],
    );
    const taken = new Set(rows.map((row) => row.name));
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
    await manager.query(`DELETE FROM "task_dependencies" WHERE "projectId" = $1`, [projectId]);
    await manager.query(
      `DELETE FROM "tasks" WHERE "projectId" = $1 AND NOT ("id" = ANY($2::uuid[]))`,
      [projectId, taskIds],
    );
    await manager.query(
      `DELETE FROM "events" WHERE "projectId" = $1 AND NOT ("id" = ANY($2::uuid[]))`,
      [projectId, eventIds],
    );
    for (const task of content.tasks) await writeTask(manager, projectId, task);
    for (const task of content.tasks) {
      if (task.parentId) await setTaskParent(manager, task.id, task.parentId);
    }
    for (const event of content.events) await writeEvent(manager, projectId, event);
    for (const link of content.links) await writeLink(manager, projectId, link);
    if (withProjectFields) {
      // The name only when none of the owner's other projects took it meanwhile (names are unique
      // among one's projects: see ProjectsService).
      await manager.query(
        `UPDATE "projects" p SET "description" = $2,
                "name" = CASE WHEN EXISTS (
                  SELECT 1 FROM "projects" o JOIN "members" m ON m."projectId" = o."id"
                   WHERE o."id" <> p."id" AND o."name" = $3
                     AND m."userId" IN (SELECT "userId" FROM "members" WHERE "projectId" = p."id"))
                  THEN p."name" ELSE $3 END
          WHERE p."id" = $1`,
        [projectId, content.project.description, content.project.name],
      );
    }
  }

  /**
   * A new version, numbered after the project's last (a lock keeps two saves apart). Then the
   * oldest are let go: starred and manual versions stay, and the KEEP_RECENT newest of the others.
   */
  private save(
    projectId: string,
    kind: VersionKind,
    content: VersionContent,
    userId: string | null,
  ) {
    return this.db.transaction(async (manager) => {
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
      return saved;
    });
  }
}
