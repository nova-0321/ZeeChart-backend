import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, MaxLength } from 'class-validator';
import { MEMBER_ROLES, type MemberRole } from '../member-role.js';

export class AddMemberDto {
  /**
   * The email they signed up with. Trimmed and lower-cased, as on sign-up. (Names are not unique,
   * so a member is found by email only.)
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email: string;

  /** Their role; editor when left out. */
  @ApiPropertyOptional({ enum: MEMBER_ROLES, enumName: 'MemberRole', default: 'editor' })
  @IsOptional()
  @IsIn(MEMBER_ROLES)
  role?: MemberRole;
}
