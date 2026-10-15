import { ApiProperty } from '@nestjs/swagger';
import type { Revision } from '../../entities/revision.entity.js';
import {
  REVISION_ACTIONS,
  REVISION_ENTITIES,
  type RevisionAction,
  type RevisionEntity,
} from '../revision-diff.js';

/** Who made a change. */
export class RevisionAuthorDto {
  id: string;
  name: string;
}

/** One change in a project's history. */
export class RevisionDto {
  id: string;

  @ApiProperty({ enum: REVISION_ENTITIES, enumName: 'RevisionEntity' })
  entityType: RevisionEntity;

  entityId: string;

  /** The entity's own count of changes: 1 for its first. */
  version: number;

  @ApiProperty({ enum: REVISION_ACTIONS, enumName: 'RevisionAction' })
  action: RevisionAction;

  /** What changed, in a sentence. */
  summary: string;

  /** null once that account is deleted. */
  changedBy: RevisionAuthorDto | null;

  /** The changes of one request share it (an edit that also moved other tasks is one action). */
  batchId: string;

  /** The change the action was about; the others in its batch happened because of it. */
  primary: boolean;

  /** The state before (null for a create) and after (null for a delete). */
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true })
  before: Record<string, unknown> | null;

  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true })
  after: Record<string, unknown> | null;

  createdAt: Date;
}

/** A revision loaded with `changedBy`, as the API answers it. */
export const asRevisionDto = (revision: Revision): RevisionDto => ({
  id: revision.id,
  entityType: revision.entityType,
  entityId: revision.entityId,
  version: revision.version,
  action: revision.action,
  summary: revision.summary,
  changedBy: revision.changedBy
    ? { id: revision.changedBy.id, name: revision.changedBy.name }
    : null,
  batchId: revision.batchId,
  primary: revision.primary,
  before: revision.before,
  after: revision.after,
  createdAt: revision.createdAt,
});
