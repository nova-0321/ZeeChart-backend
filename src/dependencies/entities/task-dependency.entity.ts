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
import { Task } from '../../tasks/entities/task.entity.js';

/** "fromTask must happen before toTask": an arrow between two bars of the same project. */
@Entity('task_dependencies')
@Unique(['fromTaskId', 'toTaskId'])
export class TaskDependency {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: false })
  projectId: string;

  /** The predecessor. */
  @Column({ type: 'uuid', nullable: false })
  fromTaskId: string;

  /** The successor. */
  @Column({ type: 'uuid', nullable: false })
  toTaskId: string;

  @Column({ type: 'enum', enum: ['FS', 'SS', 'FF', 'SF'], nullable: false, default: 'FS' })
  type: string;

  /** Days the successor waits after the predecessor; negative lets them overlap. */
  @Column({ type: 'int', nullable: false, default: 0 })
  lagDays: number;

  @CreateDateColumn()
  createdAt: Date;

  // Deleting either task deletes the dependency with it (ON DELETE CASCADE in the database).
  @ManyToOne(() => Task, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'fromTaskId' })
  fromTask: Relation<Task>;

  @ManyToOne(() => Task, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'toTaskId' })
  toTask: Relation<Task>;
}
