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
import { MEMBER_ROLES, type MemberRole } from '../member-role.js';

/**
 * Someone's place in a project, and what they may do there (see member-role.ts). The only record of
 * who can see a project: someone who is not a member gets 404 for it. A project always has at least
 * one owner (MembersService keeps it so).
 */
@Entity('members')
@Unique('UQ_members_project_user', ['projectId', 'userId'])
export class Member {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  projectId: string;

  // Typed as Relation<Project>: the circular import with Project can't break loading (see Task).
  @ManyToOne(() => Project, (project) => project.members, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId' })
  project: Relation<Project>;

  /** Indexed: "my projects" looks members up by user. */
  @Index('IDX_members_userId')
  @Column({ type: 'uuid' })
  userId: string;

  /** Deleting the account removes it from every project. */
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  @Column({ type: 'enum', enum: MEMBER_ROLES, enumName: 'member_role' })
  role: MemberRole;

  /** Who added them (null for a project's creator, or once that account is deleted). */
  @Column({ type: 'uuid', nullable: true })
  addedById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'addedById' })
  addedBy: Relation<User> | null;

  @CreateDateColumn()
  joinedAt: Date;
}
