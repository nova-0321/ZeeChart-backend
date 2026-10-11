import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Member } from '../../members/entities/member.entity.js';
import { Task } from '../../tasks/entities/task.entity.js';

// Who can see or change a project, and how, is in its members; it always has at least one owner.
// A name is unique among the projects you belong to (checked by ProjectsService; not across
// everyone: that would tell people which names others use).
@Entity('projects')
export class Project {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'boolean', default: false })
  archived: boolean;

  @OneToMany(() => Task, (task) => task.project)
  tasks: Task[];

  @OneToMany(() => Member, (member) => member.project)
  members: Member[];

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
}
