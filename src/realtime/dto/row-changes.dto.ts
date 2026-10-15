import { applyDecorators } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
  type ApiPropertyOptions,
} from '@nestjs/swagger';

// The rows a write changed (RowChanges in realtime.types.ts), as the OpenAPI document describes
// them. The rows are the REST API's own (Task, TaskDependency, ProjectEvent), named by their schema:
// this domain doesn't import the others' entities (#55).

const rowsOf = (schema: string) => ({
  type: 'array' as const,
  items: { $ref: `#/components/schemas/${schema}` },
  description: 'The rows it created or changed, as the REST API returns them',
});
const DELETED: ApiPropertyOptions = {
  type: String,
  isArray: true,
  description: 'The ids of the rows it deleted',
};

export class TaskChangesDto {
  @ApiProperty(rowsOf('Task'))
  upsert: object[];

  @ApiProperty(DELETED)
  delete: string[];
}

export class DependencyChangesDto {
  @ApiProperty(rowsOf('TaskDependency'))
  upsert: object[];

  @ApiProperty(DELETED)
  delete: string[];
}

export class EventChangesDto {
  @ApiProperty(rowsOf('ProjectEvent'))
  upsert: object[];

  @ApiProperty(DELETED)
  delete: string[];
}

/** The project's own fields (a member's role in it is per person, so not here). */
export class ProjectFieldsDto {
  id: string;
  name: string;

  @ApiProperty({ type: String, nullable: true })
  description: string | null;

  archived: boolean;
  version: number;
}

/**
 * Every row the write changed: the one it was about and the ones it moved with it (linked tasks
 * pushed, a group stretched, tasks renumbered). A kind it didn't change is absent.
 */
export class RowChangesDto {
  @ApiPropertyOptional({ type: TaskChangesDto })
  tasks?: TaskChangesDto;

  @ApiPropertyOptional({ type: DependencyChangesDto })
  dependencies?: DependencyChangesDto;

  @ApiPropertyOptional({ type: EventChangesDto })
  events?: EventChangesDto;

  @ApiPropertyOptional({ type: ProjectFieldsDto })
  project?: ProjectFieldsDto;
}

/**
 * The answer of a write to one row: that row (`schema`), with `changes`, every row the write
 * changed. Absent when it changed too many rows to send (then load the project again). See #75.
 */
export const AnswerWithChanges = (schema: string, status: 200 | 201 = 200) =>
  applyDecorators(
    ApiExtraModels(RowChangesDto),
    (status === 201 ? ApiCreatedResponse : ApiOkResponse)({
      description: `The ${schema}, with every row the write changed`,
      schema: {
        allOf: [
          { $ref: `#/components/schemas/${schema}` },
          {
            type: 'object',
            properties: { changes: { $ref: getSchemaPath(RowChangesDto) } },
          },
        ],
      },
    }),
  );
