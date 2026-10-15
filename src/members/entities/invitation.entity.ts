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
 * A place in a project kept for someone who has no account yet (#20), taken up with a secret link:
 * whoever opens it, signs up or in, and accepts becomes a member with this role, and the invitation
 * goes. Only the link's hash is kept. The email only says who it is meant for (the owner's list);
 * it gives nothing by itself, so signing up with it is not enough to join.
 */
@Entity('invitations')
@Unique('UQ_invitations_project_email', ['projectId', 'email'])
export class Invitation {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_invitations' })
  id: string;

  @Column({ type: 'uuid' })
  projectId: string;

  // Typed as Relation<Project>: the circular import with Project can't break loading (see Task).
  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'projectId', foreignKeyConstraintName: 'FK_invitations_project' })
  project: Relation<Project>;

  /** Lower-cased, as accounts store it. Indexed: a sign-in looks invitations up by email. */
  @Index('IDX_invitations_email')
  @Column({ type: 'varchar', length: 254 })
  email: string;

  @Column({ type: 'enum', enum: MEMBER_ROLES, enumName: 'member_role' })
  role: MemberRole;

  /** Who invited them (null once that account is deleted). They become the member's `addedBy`. */
  @Column({ type: 'uuid', nullable: true })
  invitedById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'invitedById', foreignKeyConstraintName: 'FK_invitations_invited_by' })
  invitedBy: Relation<User> | null;

  /** sha256 of the link's secret (see MembersService): looked up when a link is opened. */
  @Index('IDX_invitations_tokenHash', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  tokenHash: string;

  /** The link works until then (a new link can be made, which starts the time again). */
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
