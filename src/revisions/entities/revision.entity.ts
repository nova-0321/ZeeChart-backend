import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  Unique,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity.js';
import { Project } from '../../projects/entities/project.entity.js';
import {
  REVISION_ACTIONS,
  REVISION_ENTITIES,
  type RevisionAction,
  type RevisionEntity,
} from '../revision-diff.js';

/**
 * One change to a project, task or event: its state before and after, who made it, and a sentence
 * that says what changed. Written for every change (see RevisionInterceptor), never edited. Each
 * entity's revisions are numbered 1, 2, 3... (`version`). The changes of one request share a
 * `batchId` (an edit that also moved groups and linked tasks is one action).
 */
export const BATCH_KINDS = ['change', 'undo', 'redo'] as const;
export type BatchKind = (typeof BATCH_KINDS)[number];

@Entity('revisions')
@Unique('UQ_revisions_entity_version', ['entityId', 'version'])
@Index('IDX_revisions_project_created', ['projectId', 'createdAt'])
@Index('IDX_revisions_project_author', ['projectId', 'changedById', 'createdAt'])
export class Revision {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The history goes with the project (a deleted project has none left). */
  @Column({ type: 'uuid' })
  projectId: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project: Relation<Project>;

  @Column({ type: 'enum', enum: REVISION_ENTITIES, enumName: 'revision_entity' })
  entityType: RevisionEntity;

  /** Not a foreign key: a deleted task or event keeps its history (and can be restored from it). */
  @Column({ type: 'uuid' })
  entityId: string;

  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'enum', enum: REVISION_ACTIONS, enumName: 'revision_action' })
  action: RevisionAction;

  /** null when the account is deleted. */
  @Column({ type: 'uuid', nullable: true })
  changedById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'changedById' })
  changedBy: Relation<User> | null;

  @Column({ type: 'text' })
  summary: string;

  /** The state before (null for a create). */
  @Column({ type: 'jsonb', nullable: true })
  before: Record<string, unknown> | null;

  /** The state after (null for a delete). */
  @Column({ type: 'jsonb', nullable: true })
  after: Record<string, unknown> | null;

  @Column({ type: 'uuid' })
  batchId: string;

  /**
   * What the batch was: a change, or an undo / redo of another batch (`ofBatch`). The undo and redo
   * stacks of each person are read from these (see UndoService).
   */
  @Column({ type: 'enum', enum: BATCH_KINDS, enumName: 'revision_batch_kind', default: 'change' })
  batchKind: BatchKind;

  @Column({ type: 'uuid', nullable: true })
  ofBatch: string | null;

  /** The change the request was about, in its batch (the others happened because of it). */
  @Column({ type: 'boolean', default: false })
  primary: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
