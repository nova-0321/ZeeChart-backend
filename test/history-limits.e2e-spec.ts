import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/validation.js';
import { KEEP_MANUAL_VERSIONS, MAX_STARRED_VERSIONS } from '../src/revisions/history-limits.js';
import { RevisionsService } from '../src/revisions/history/revisions.service.js';
import { VersionsService } from '../src/revisions/versions/versions.service.js';
import { deleteTestAccounts } from './cleanup.js';

// How much history a project keeps (#54): versions saved by hand and starred ones are capped, a
// save that would only copy the newest version keeps that one, and old revisions are let go,
// except what undo, the conflict check and the numbering of the next change still read.

interface Version {
  id: string;
  number: number;
  kind: string;
  starred: boolean;
}
interface Revision {
  entityId: string;
  version: number;
  action: string;
}

describe('History limits (e2e)', () => {
  let app: INestApplication;
  let db: DataSource;
  let token = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
    db = app.get(DataSource);
    const signUp = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({
        name: 'Keeper',
        email: `zzkeep-${randomUUID()}@example.com`,
        password: 'pass-word-1',
      })
      .expect(201);
    token = (signUp.body as { accessToken: string }).accessToken;
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzkeep-');
    await app.close();
  });

  const call = (method: 'get' | 'post' | 'patch' | 'delete', path: string, body?: object) =>
    request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`).send(body);
  const newProject = async () =>
    (
      (await call('post', '/projects', { name: `Keep ${randomUUID()}` }).expect(201)).body as {
        id: string;
      }
    ).id;
  const newTask = async (projectId: string, name: string) =>
    (
      await call('post', '/tasks', {
        projectId,
        name,
        color: '#2a78d6',
        startDate: '2026-11-02',
        endDate: '2026-11-03',
      }).expect(201)
    ).body as { id: string };
  const rename = (taskId: string, name: string) =>
    call('patch', `/tasks/${taskId}`, { name }).expect(200);
  /** Every version of the project, newest first: page after page (the list comes 50 at a time). */
  const versions = async (projectId: string) => {
    const all: Version[] = [];
    for (;;) {
      const before = all.length > 0 ? `?before=${all.at(-1)!.id}` : '';
      const page = (await call('get', `/projects/${projectId}/versions${before}`).expect(200))
        .body as Version[];
      all.push(...page);
      if (page.length === 0) return all;
    }
  };
  /** "Save a version now": 201 when it made one, 200 when it kept the newest. */
  const saveNow = async (projectId: string, status = 201) =>
    (await call('post', `/projects/${projectId}/versions`).expect(status)).body as Version;
  const revisionsOf = async (projectId: string, entityId: string) =>
    (
      (await call('get', `/projects/${projectId}/revisions?limit=100`).expect(200))
        .body as Revision[]
    )
      .filter((r) => r.entityId === entityId)
      .map((r) => r.version)
      .sort((a, b) => a - b);
  /** Makes every revision of the project look `days` days old. */
  const age = (projectId: string, days: number) =>
    db.query(
      `UPDATE "revisions" SET "createdAt" = "createdAt" - make_interval(days => $2) WHERE "projectId" = $1`,
      [projectId, days],
    );

  describe('versions', () => {
    it('saving what the newest version already holds keeps that one (as saved by hand), not a copy', async () => {
      const projectId = await newProject();
      await newTask(projectId, 'A'); // v2, auto: the first change of a new project
      const [newest] = await versions(projectId);
      expect(newest).toMatchObject({ number: 2, kind: 'auto' });

      // 200, not 201: nothing was made.
      const saved = await saveNow(projectId, 200);
      expect(saved).toMatchObject({ id: newest!.id, number: 2, kind: 'manual' });
      expect((await versions(projectId)).map((v) => v.number)).toEqual([2, 1]);
      // Once something changed, a save is a new version again.
      await newTask(projectId, 'B');
      expect(await saveNow(projectId)).toMatchObject({ number: 3, kind: 'manual' });
    });

    it(`keeps the ${KEEP_MANUAL_VERSIONS} newest saved by hand, and starred ones besides`, async () => {
      const projectId = await newProject();
      const task = await newTask(projectId, 'T');
      // The auto version of the first change already holds this: it is kept as saved by hand (200).
      const first = await saveNow(projectId, 200);
      await call('patch', `/versions/${first.id}`, { starred: true }).expect(200);
      let second: Version | undefined;
      for (let i = 1; i <= KEEP_MANUAL_VERSIONS + 1; i++) {
        await rename(task.id, `T ${i}`);
        const saved = await saveNow(projectId);
        second ??= saved;
      }
      const manual = (await versions(projectId)).filter((v) => v.kind === 'manual');
      const unstarred = manual.filter((v) => !v.starred);
      expect(unstarred).toHaveLength(KEEP_MANUAL_VERSIONS);
      // The oldest unstarred one went; the starred one, older still, stayed.
      expect(manual.map((v) => v.id)).not.toContain(second!.id);
      expect(manual.find((v) => v.id === first.id)).toMatchObject({ starred: true });
    }, 120_000);

    it(`stars ${MAX_STARRED_VERSIONS} versions at most: one more is refused until one is unstarred`, async () => {
      const projectId = await newProject();
      const task = await newTask(projectId, 'T');
      const saved: Version[] = [];
      for (let i = 0; i <= MAX_STARRED_VERSIONS; i++) {
        await rename(task.id, `T ${i}`);
        saved.push(await saveNow(projectId));
      }
      const star = (version: Version, starred = true) =>
        call('patch', `/versions/${version.id}`, { starred });
      for (const version of saved.slice(0, MAX_STARRED_VERSIONS)) await star(version).expect(200);
      // Starring one that is already starred changes nothing, so it isn't refused.
      await star(saved[0]!).expect(200);

      const refused = await star(saved[MAX_STARRED_VERSIONS]!);
      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toBe(
        `A project can have ${MAX_STARRED_VERSIONS} starred versions at most. Unstar one first`,
      );
      await star(saved[0]!, false).expect(200);
      await star(saved[MAX_STARRED_VERSIONS]!).expect(200);
    }, 120_000);
  });

  describe('two people at once', () => {
    /** Sends both requests together, so both are in flight at the same time. */
    const together = (a: request.Test, b: request.Test) =>
      Promise.all([a.then((r) => r), b.then((r) => r)]);
    /**
     * Holds every call of `method` for a moment, `after` it read (a check) or `before` it writes:
     * the gap between a check and the write it allows, wide enough that two requests not kept
     * apart would both pass the check.
     */
    const slowDown = (target: object, method: string, when: 'after' | 'before') => {
      const host = target as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = host[method]!;
      const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
      vi.spyOn(host, method).mockImplementation(async function (this: unknown, ...args: unknown[]) {
        if (when === 'before') await pause();
        const result = await original.apply(this, args);
        if (when === 'after') await pause();
        return result;
      });
    };

    it(`two stars at once past ${MAX_STARRED_VERSIONS - 1}: one goes through, the other is refused`, async () => {
      const projectId = await newProject();
      const task = await newTask(projectId, 'T');
      const saved: Version[] = [];
      for (let i = 0; i <= MAX_STARRED_VERSIONS; i++) {
        await rename(task.id, `T ${i}`);
        saved.push(await saveNow(projectId));
      }
      for (const version of saved.slice(0, MAX_STARRED_VERSIONS - 1)) {
        await call('patch', `/versions/${version.id}`, { starred: true }).expect(200);
      }
      // The count of starred versions, before the star is written.
      slowDown(Repository.prototype, 'countBy', 'after');
      const [a, b] = saved.slice(MAX_STARRED_VERSIONS - 1);
      const results = await together(
        call('patch', `/versions/${a!.id}`, { starred: true }),
        call('patch', `/versions/${b!.id}`, { starred: true }),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await versions(projectId)).filter((v) => v.starred)).toHaveLength(
        MAX_STARRED_VERSIONS,
      );
    }, 120_000);

    it('two "Save a version now" at once with nothing between: one version is made, not two', async () => {
      const projectId = await newProject();
      const task = await newTask(projectId, 'T');
      await rename(task.id, 'T changed');
      const before = (await versions(projectId)).length;
      // Between "nothing new to save?" and the save.
      slowDown(app.get(VersionsService), 'save', 'before');
      const results = await together(
        call('post', `/projects/${projectId}/versions`),
        call('post', `/projects/${projectId}/versions`),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
      const [first, second] = results.map((r) => (r.body as Version).id);
      expect(first).toBe(second);
      expect(await versions(projectId)).toHaveLength(before + 1);
    });
  });

  describe('revisions', () => {
    const prune = (projectId: string, batches: number) =>
      app.get(RevisionsService).prune(projectId, { days: 30, batches });

    it('lets old revisions go, but keeps the newest batches and the newest revision of each row', async () => {
      const projectId = await newProject();
      const task = await newTask(projectId, 'T'); // version 1
      for (let i = 1; i <= 5; i++) await rename(task.id, `T ${i}`); // versions 2 to 6
      await age(projectId, 60);

      // The 2 newest batches (versions 5 and 6) stay; so does the project's own (only) revision.
      expect(await prune(projectId, 2)).toBe(4);
      expect(await revisionsOf(projectId, task.id)).toEqual([5, 6]);
      expect(await revisionsOf(projectId, projectId)).toEqual([1]);
      // Pruning again finds nothing more.
      expect(await prune(projectId, 2)).toBe(0);
    });

    it('a row that is gone keeps nothing old (its history is not kept forever); one still there keeps its newest', async () => {
      const projectId = await newProject();
      const kept = await newTask(projectId, 'Kept');
      const gone = await newTask(projectId, 'Gone');
      // A version that has it, to bring it back from below.
      const version = await saveNow(projectId);
      await call('delete', `/tasks/${gone.id}`).expect(204);
      for (let i = 1; i <= 3; i++) await rename(kept.id, `Kept ${i}`);
      await age(projectId, 60);

      await prune(projectId, 1);
      expect(await revisionsOf(projectId, gone.id)).toEqual([]);
      expect(await revisionsOf(projectId, kept.id)).toEqual([4]);

      // Brought back by a version after its history went: numbered from 1 again, no clash.
      await call('post', `/versions/${version.id}/restore`).expect(201);
      expect(await revisionsOf(projectId, gone.id)).toEqual([1]);
    });

    it('never lets go of revisions newer than 30 days, however many', async () => {
      const projectId = await newProject();
      const task = await newTask(projectId, 'T');
      for (let i = 1; i <= 5; i++) await rename(task.id, `T ${i}`);
      expect(await prune(projectId, 1)).toBe(0);
      expect(await revisionsOf(projectId, task.id)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('after pruning, the next change is numbered on, and undo and redo still work', async () => {
      const projectId = await newProject();
      const task = await newTask(projectId, 'T');
      for (let i = 1; i <= 5; i++) await rename(task.id, `T ${i}`); // versions 2 to 6
      await call('post', `/projects/${projectId}/undo`).expect(201); // back to "T 4": version 7
      await age(projectId, 60);
      // Only the undo is among the newest: it is kept, and so is the batch it undid (redo needs it).
      await prune(projectId, 1);
      expect(await revisionsOf(projectId, task.id)).toEqual([6, 7]);

      await call('post', `/projects/${projectId}/redo`).expect(201); // "T 5" again: version 8
      const named = async () =>
        (
          (await call('get', `/tasks?projectId=${projectId}`).expect(200)).body as {
            id: string;
            name: string;
            version: number;
          }[]
        ).find((t) => t.id === task.id)!;
      expect(await named()).toMatchObject({ name: 'T 5', version: 8 });
      await rename(task.id, 'T 6');
      expect(await named()).toMatchObject({ name: 'T 6', version: 9 });
    });

    it('runs after a change that saved a version of the project, not after every change', async () => {
      const prune = vi.spyOn(app.get(RevisionsService), 'prune');
      const projectId = await newProject();
      await newTask(projectId, 'A'); // the first change of a new project: a version, so a prune
      expect(prune).toHaveBeenCalledTimes(1);
      expect(prune).toHaveBeenCalledWith(projectId);
      await newTask(projectId, 'B'); // a minute later: no version yet, no prune
      expect(prune).toHaveBeenCalledTimes(1);
    });
  });
});
