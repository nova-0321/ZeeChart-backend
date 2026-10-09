import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity.js';
import { Task } from '../../tasks/entities/task.entity.js';

// A name is unique among one owner's projects (not across everyone: that would tell people which
// names others use).
@Entity('projects')
@Unique('UQ_projects_owner_name', ['ownerId', 'name'])
export class Project {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  /** Who the project belongs to: the only one who can see or change it (until #18 / #20). */
  @Column({ type: 'uuid' })
  ownerId: string;

  /** Every project has an owner; deleting the account deletes its projects. */
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerId' })
  owner: User;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'boolean', default: false })
  archived: boolean;

  @OneToMany(() => Task, (task) => task.project)
  tasks: Task[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
