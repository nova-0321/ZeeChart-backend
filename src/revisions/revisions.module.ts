import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from '../database/database.module.js';
import { HistoryModule } from './history/history.module.js';
import { RevisionInterceptor } from './revision.interceptor.js';
import { UndoModule } from './undo/undo.module.js';
import { VersionsModule } from './versions/versions.module.js';

/**
 * Each project's history (#19), in three parts (#59): `history/` (what changed, restoring from it,
 * conflicts), `undo/` (one's own changes back and forth) and `versions/` (the whole project, saved
 * and restored). They share the tables (`entities/`), the snapshot of a project (revision-state.ts)
 * and RevisionInterceptor, which records every change and saves a version after it.
 */
@Module({
  imports: [
    HistoryModule,
    UndoModule,
    VersionsModule,
    // ProjectWriteLock and RequestTransaction, for the interceptor.
    DatabaseModule,
  ],
  providers: [
    // On every route; it acts only on the write routes of a project (see the interceptor).
    { provide: APP_INTERCEPTOR, useClass: RevisionInterceptor },
  ],
})
export class RevisionsModule {}
