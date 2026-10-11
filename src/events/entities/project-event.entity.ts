import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { Project } from '../../projects/entities/project.entity.js';

/**
 * A stretch of days that matters to the whole project (a freeze, a holiday, a sprint, a stress
 * period...). It is drawn across the timeline, not tied to any task.
 */
@Entity('events')
export class ProjectEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', nullable: false })
  name: string;

  @Column({ type: 'text', nullable: false })
  color: string;

  /** First day of the event. */
  @Column({ type: 'date', nullable: false })
  startDate: string;

  /** Last day of the event (included). */
  @Column({ type: 'date', nullable: false })
  endDate: string;

  @Column({ type: 'uuid', nullable: false })
  projectId: string;

  @CreateDateColumn()
  createdAt: Date;

  /**
   * How many changes it has had: the same number as its last revision (RevisionsService). A write
   * may send the one it last saw (If-Match) to be stopped when someone else changed the same thing
   * since (see docs/conflicts.md).
   */
  @Column({ type: 'int', default: 0 })
  version: number;

  @UpdateDateColumn()
  updatedAt: Date;

  // An event belongs to a project and goes with it (ON DELETE CASCADE in the database).
  @ManyToOne(() => Project, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project: Relation<Project>;
}
