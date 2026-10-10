import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { MEMBER_ROLES, type MemberRole } from '../member-role.js';

export class ChangeRoleDto {
  @ApiProperty({ enum: MEMBER_ROLES, enumName: 'MemberRole' })
  @IsIn(MEMBER_ROLES)
  role: MemberRole;
}
