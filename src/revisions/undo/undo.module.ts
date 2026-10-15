import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { SchedulingModule } from '../../tasks/scheduling/scheduling.module.js';
import { Revision } from '../entities/revision.entity.js';
import { UndoController } from './undo.controller.js';
import { UndoService } from './undo.service.js';

/** Undo and redo of one's own changes, read from the history (#19). */
@Module({
  imports: [
    // AuthGuard (and the JwtService it needs).
    AuthModule,
    // RequestTransaction: each write's one transaction.
    DatabaseModule,
    TypeOrmModule.forFeature([Revision]),
    // The groups an undo touches fit their tasks again.
    SchedulingModule,
  ],
  controllers: [UndoController],
  providers: [UndoService],
})
export class UndoModule {}
