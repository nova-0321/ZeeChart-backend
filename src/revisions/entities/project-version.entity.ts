import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  Unique,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity.js';
import { Project } from '../../projects/entities/project.entity.js';
import type { VersionContent } from '../versions/version-content.js';

export const VERSION_KINDS = ['auto', 'manual', 'before-restore'] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];

/**
 * The whole project at one moment (its tasks, events and links), to look at or go back to:
 * - `auto`: saved by itself while people edit (at most one every 10 minutes);
 * - `manual`: someone pressed "Save a version now";
 * - `before-restore`: how it was just before another version was restored (so that can be undone).
 * Numbered v1, v2, v3... per project. A starred one is marked to keep an eye on.
 */
@Entity('project_versions')
@Unique('UQ_project_versions_number', ['projectId', 'number'])
export class ProjectVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  projectId: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project: Relation<Project>;

  @Column({ type: 'int' })
  number: number;

  @Column({ type: 'enum', enum: VERSION_KINDS, enumName: 'version_kind' })
  kind: VersionKind;

  @Column({ type: 'boolean', default: false })
  starred: boolean;

  @Column({ type: 'jsonb' })
  content: VersionContent;

  /** Who saved it (for auto: whose change it followed); null once that account is deleted. */
  @Column({ type: 'uuid', nullable: true })
  createdById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'createdById' })
  createdBy: Relation<User> | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
