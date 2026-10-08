import { IsUUID, ValidateIf } from 'class-validator';

export class SetParentDto {
  /** Id of the group to move the task under, or null to make it top-level. */
  @ValidateIf((dto: SetParentDto) => dto.parentId !== null)
  @IsUUID()
  parentId: string | null;
}
