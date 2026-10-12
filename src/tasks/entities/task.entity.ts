import {
  Index,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  type Relation,
  UpdateDateColumn,
} from 'typeorm';
import { Project } from '../../projects/entities/project.entity.js';

@Entity('tasks')
// Every read of a project's tasks is by project; a group's children by parent.
@Index('IDX_tasks_projectId', ['projectId'])
@Index('IDX_tasks_parentId', ['parentId'])
export class Task {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text', nullable: false })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column()
  progress: number;

  @Column({ type: 'uuid', nullable: false })
  projectId: string;

  @Column({ type: 'enum', enum: ['group', 'task', 'milestone'], nullable: false, default: 'task' })
  type: string;

  @Column({ type: 'enum', enum: ['low', 'medium', 'high'], nullable: false, default: 'medium' })
  priority: string;

  @Column({ type: 'date', default: () => 'CURRENT_DATE' })
  startDate: Date;

  @Column({ type: 'date', default: () => 'CURRENT_DATE' })
  endDate: Date;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'text', nullable: false })
  color: string;

  @Column({ type: 'int', nullable: false })
  order: number;

  /**
   * How many changes it has had: the same number as its last revision (RevisionsService). A write
   * may send the one it last saw (If-Match) to be stopped when someone else changed the same thing
   * since (see docs/conflicts.md).
   */
  @Column({ type: 'int', default: 0 })
  version: number;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'uuid', nullable: true })
  parentId: string | null;

  @ManyToOne(() => Task, (task) => task.children, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'parentId' })
  parent: Task | null;

  // A task always belongs to a project and is deleted with it (ON DELETE CASCADE in the
  // database). Typed as Relation<Project> so the circular import with Project cannot break
  // loading: the plain type would be read while the module is still being set up.
  @ManyToOne(() => Project, (project) => project.tasks, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project: Relation<Project>;

  @OneToMany(() => Task, (task) => task.parent)
  children: Task[];
}
