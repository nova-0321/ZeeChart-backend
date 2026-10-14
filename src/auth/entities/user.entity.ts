import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Someone who can sign in. The email is stored lower-case, so it is unique whatever the case.
 * Members of a project (#18) refer to this table.
 */
@Entity('users')
@Unique('UQ_users_email', ['email'])
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 254 })
  email: string;

  /** The scrypt hash (see password.ts). Never selected unless asked for, never sent. */
  @Column({ type: 'varchar', length: 255, select: false })
  passwordHash: string;

  /**
   * Raised to end every sign-in of this account at once (sign out everywhere): a token carries the
   * number it was made with and works only while it is still the account's (see token.ts).
   */
  @Column({ type: 'integer', default: 0 })
  tokenVersion: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
