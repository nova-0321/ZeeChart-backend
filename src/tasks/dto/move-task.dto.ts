import { IsInt, IsUUID, Min, ValidateIf } from 'class-validator';

export class MoveTaskDto {
  /** Id of the group the task goes in, or null for the top level. */
  @ValidateIf((dto: MoveTaskDto) => dto.parentId !== null)
  @IsUUID()
  parentId: string | null;

  /** Its place among the tasks of that group (or of the top level), counting from 0. */
  @IsInt()
  @Min(0)
  index: number;
}
