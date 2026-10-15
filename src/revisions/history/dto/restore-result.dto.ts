import { ApiProperty } from '@nestjs/swagger';
import { REVISION_ENTITIES, type RevisionEntity } from '../revision-diff.js';

/** What a restore did. */
export class RestoreResultDto {
  @ApiProperty({ enum: REVISION_ENTITIES, enumName: 'RevisionEntity' })
  entityType: RevisionEntity;

  entityId: string;

  /** Restored to this version of the entity. */
  version: number;

  /** What could not be brought back (a link to a task that is gone, a group that is gone). */
  skipped: string[];
}
