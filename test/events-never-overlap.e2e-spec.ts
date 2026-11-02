import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { createValidationPipe } from '../src/common/validation.js';
import { EventsNeverOverlap1793200000000 } from '../src/database/migrations/1793200000000-EventsNeverOverlap.js';
import { deleteTestAccounts } from './cleanup.js';

// No two events of a project share a day (#84): a new event goes after the one on its days, a
// moved or resized one pushes the others, in the same write (its changes, its history, one undo).

interface EventBody {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  changes?: { events?: { upsert: EventBody[] } };
}

interface RevisionBody {
  id: string;
  entityType: string;
  entityId: string;
  batchId: string;
  version: number;
}

describe('Events never overlap (e2e)', () => {
  let app: INestApplication;
  let token = '';
  let projectId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createValidationPipe());
    await app.listen(0);
    const signUp = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({
        name: 'Events',
        email: `zzevents-${randomUUID()}@example.com`,
        password: 'pass-word-1',
      })
      .expect(201);
    token = (signUp.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await deleteTestAccounts(app, 'zzevents-');
    await app.close();
  });

  beforeEach(async () => {
    projectId = (
      (
        await call('post', '/projects')
          .send({ name: `zzevents ${randomUUID()}` })
          .expect(201)
      ).body as { id: string }
    ).id;
  });

  const call = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
    request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`);
  const create = (name: string, startDate: string, endDate: string) =>
    call('post', '/events').send({ projectId, name, color: '#e5484d', startDate, endDate });
  const newEvent = async (name: string, startDate: string, endDate: string) =>
    (await create(name, startDate, endDate).expect(201)).body as EventBody;
  const patch = (id: string, body: object) => call('patch', `/events/${id}`).send(body).expect(200);
  /** The project's events as "name start..end", in start order. */
  const events = async () =>
    ((await call('get', `/events?projectId=${projectId}`).expect(200)).body as EventBody[]).map(
      (event) => `${event.name} ${event.startDate}..${event.endDate}`,
    );
  const history = async () =>
    (await call('get', `/projects/${projectId}/revisions`).expect(200)).body as RevisionBody[];
  const undo = () => call('post', `/projects/${projectId}/undo`).expect(200);

  it('a new event on taken days goes after the event there, keeping its length', async () => {
    await newEvent('Launch', '2026-10-10', '2026-10-20');
    const placed = await newEvent('Review', '2026-10-15', '2026-10-18');
    expect(placed).toMatchObject({ startDate: '2026-10-21', endDate: '2026-10-24' });
    expect(await events()).toEqual([
      'Launch 2026-10-10..2026-10-20',
      'Review 2026-10-21..2026-10-24',
    ]);
  });

  it('a new event moves on until it is free, and a free one stays where it was put', async () => {
    await newEvent('A', '2026-10-10', '2026-10-20');
    await newEvent('B', '2026-10-22', '2026-10-25');
    // After A (21–24) it would share days with B: after B.
    expect(await newEvent('C', '2026-10-15', '2026-10-18')).toMatchObject({
      startDate: '2026-10-26',
      endDate: '2026-10-29',
    });
    // The end day counts: touching A's last day is taken, the day after is free.
    expect(await newEvent('D', '2026-10-01', '2026-10-10')).toMatchObject({
      startDate: '2026-10-30',
      endDate: '2026-11-08',
    });
    expect(await newEvent('E', '2026-09-20', '2026-09-30')).toMatchObject({
      startDate: '2026-09-20',
      endDate: '2026-09-30',
    });
  });

  it('a move pushes the events it now overlaps and the ones after them, all in its changes and history', async () => {
    const e = await newEvent('E', '2026-10-01', '2026-10-03');
    const d = await newEvent('D', '2026-10-10', '2026-10-14');
    const f = await newEvent('F', '2026-10-16', '2026-10-17');
    const g = await newEvent('G', '2026-10-19', '2026-10-30');
    await newEvent('H', '2026-11-20', '2026-11-21');

    const answer = (await patch(e.id, { startDate: '2026-10-08', endDate: '2026-10-12' }))
      .body as EventBody;

    expect(answer).toMatchObject({ startDate: '2026-10-08', endDate: '2026-10-12' });
    expect(await events()).toEqual([
      'E 2026-10-08..2026-10-12',
      'D 2026-10-13..2026-10-17',
      'F 2026-10-18..2026-10-19',
      'G 2026-10-20..2026-10-31',
      'H 2026-11-20..2026-11-21',
    ]);
    // Every moved event is in the answer's changes (for the tab that made it and the message).
    const upserted = answer.changes?.events?.upsert ?? [];
    expect(upserted.map((event) => event.id).sort()).toEqual([e.id, d.id, f.id, g.id].sort());
    // One history batch for all of it.
    const revisions = await history();
    const batch = revisions.filter((r) => r.batchId === revisions[0]!.batchId);
    expect(batch.map((r) => r.entityId).sort()).toEqual([e.id, d.id, f.id, g.id].sort());

    // One undo puts every event back.
    await undo();
    expect(await events()).toEqual([
      'E 2026-10-01..2026-10-03',
      'D 2026-10-10..2026-10-14',
      'F 2026-10-16..2026-10-17',
      'G 2026-10-19..2026-10-30',
      'H 2026-11-20..2026-11-21',
    ]);
  });

  it('a resize pushes the next event, and a rename moves nothing', async () => {
    const a = await newEvent('A', '2026-10-10', '2026-10-12');
    await newEvent('B', '2026-10-13', '2026-10-15');
    await patch(a.id, { endDate: '2026-10-14' });
    expect(await events()).toEqual(['A 2026-10-10..2026-10-14', 'B 2026-10-15..2026-10-17']);
    // A move into the middle of an event that starts earlier pushes that one after it.
    const c = await newEvent('C', '2026-11-01', '2026-11-01');
    await patch(c.id, { startDate: '2026-10-11', endDate: '2026-10-11' });
    expect(await events()).toEqual([
      'C 2026-10-11..2026-10-11',
      'A 2026-10-12..2026-10-16',
      'B 2026-10-17..2026-10-19',
    ]);
    const before = (await history()).length;
    await patch(a.id, { name: 'A2' });
    expect(await events()).toEqual([
      'C 2026-10-11..2026-10-11',
      'A2 2026-10-12..2026-10-16',
      'B 2026-10-17..2026-10-19',
    ]);
    expect((await history()).length).toBe(before + 1);
  });

  it('two events made at once on the same days do not overlap', async () => {
    const answers = await Promise.all(
      Array.from({ length: 4 }, (_, i) => create(`Same ${i}`, '2026-10-10', '2026-10-12')),
    );
    for (const answer of answers) expect(answer.status).toBe(201);
    const days = (answers.map((answer) => answer.body) as EventBody[])
      .map((event) => event.startDate)
      .sort();
    expect(days).toEqual(['2026-10-10', '2026-10-13', '2026-10-16', '2026-10-19']);
  });

  it('restoring a revision of an event follows the move rule', async () => {
    const x = await newEvent('X', '2026-10-01', '2026-10-03');
    await patch(x.id, { startDate: '2026-10-20', endDate: '2026-10-22' });
    await newEvent('Y', '2026-10-01', '2026-10-03');
    const made = (await history()).find((r) => r.entityId === x.id && r.version === 1)!;
    await call('post', `/revisions/${made.id}/restore`).expect(200);
    expect(await events()).toEqual(['X 2026-10-01..2026-10-03', 'Y 2026-10-04..2026-10-06']);
  });

  it('restoring a deleted event puts it on its days and moves the event there now', async () => {
    const x = await newEvent('X', '2026-10-01', '2026-10-03');
    await call('delete', `/events/${x.id}`).expect(204);
    await newEvent('Y', '2026-10-02', '2026-10-02');
    const deletion = (await history()).find((r) => r.entityId === x.id && r.version === 2)!;
    await call('post', `/revisions/${deletion.id}/restore`).expect(200);
    expect(await events()).toEqual(['X 2026-10-01..2026-10-03', 'Y 2026-10-04..2026-10-04']);
  });

  it('restoring a version with overlapping events (from before the rule) lines them up', async () => {
    const a = await newEvent('A', '2026-10-01', '2026-10-05');
    const b = await newEvent('B', '2026-10-10', '2026-10-11');
    // As old data could be.
    await app
      .get(DataSource)
      .query(
        `UPDATE "events" SET "startDate" = '2026-10-03', "endDate" = '2026-10-04' WHERE "id" = $1`,
        [b.id],
      );
    const version = (await call('post', `/projects/${projectId}/versions`)).body as {
      id: string;
    };
    await patch(a.id, { name: 'A2' });
    await call('post', `/versions/${version.id}/restore`).expect(200);
    expect(await events()).toEqual(['A 2026-10-01..2026-10-05', 'B 2026-10-06..2026-10-07']);
  });

  it('the migration lines up stored overlapping events by start, keeping their lengths', async () => {
    const ids = [
      await newEvent('A', '2026-10-01', '2026-10-05'),
      await newEvent('B', '2026-10-20', '2026-10-21'),
      await newEvent('C', '2026-11-01', '2026-11-03'),
      await newEvent('D', '2026-12-01', '2026-12-01'),
    ].map((event) => event.id);
    const db = app.get(DataSource);
    const set = (id: string, start: string, end: string) =>
      db.query(`UPDATE "events" SET "startDate" = $2, "endDate" = $3 WHERE "id" = $1`, [
        id,
        start,
        end,
      ]);
    // B inside A, C on A's last day, D far away (stays).
    await set(ids[1]!, '2026-10-02', '2026-10-03');
    await set(ids[2]!, '2026-10-05', '2026-10-07');

    const runner = db.createQueryRunner();
    try {
      await new EventsNeverOverlap1793200000000().up(runner);
    } finally {
      await runner.release();
    }

    expect(await events()).toEqual([
      'A 2026-10-01..2026-10-05',
      'B 2026-10-06..2026-10-07',
      'C 2026-10-08..2026-10-10',
      'D 2026-12-01..2026-12-01',
    ]);
  });
});
