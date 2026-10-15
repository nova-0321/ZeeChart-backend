import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import {
  type ProjectVersion,
  VERSION_KINDS,
  type VersionKind,
} from '../../entities/project-version.entity.js';
import type { VersionContent } from '../version-content.js';
import { RevisionAuthorDto } from '../../history/dto/revision.dto.js';

/** A version in the list: what it is and how much is in it, not the contents themselves. */
export class VersionSummaryDto {
  id: string;
  /** v1, v2, v3... in the project. */
  number: number;

  @ApiProperty({ enum: VERSION_KINDS, enumName: 'VersionKind' })
  kind: VersionKind;

  starred: boolean;
  /** Who saved it (for auto: whose change it followed); null once that account is deleted. */
  createdBy: RevisionAuthorDto | null;
  createdAt: Date;
  /** How many tasks and events it holds. */
  tasks: number;
  events: number;
}

/** A version with its contents: the project, its tasks, events and links at that moment. */
export class VersionDto extends VersionSummaryDto {
  @ApiProperty({ type: 'object', additionalProperties: true })
  content: VersionContent;
}

export const asVersionDto = (version: ProjectVersion): VersionDto => ({
  id: version.id,
  number: version.number,
  kind: version.kind,
  starred: version.starred,
  createdAt: version.createdAt,
  createdBy: version.createdBy ? { id: version.createdBy.id, name: version.createdBy.name } : null,
  tasks: version.content.tasks.length,
  events: version.content.events.length,
  content: version.content,
});

export class UpdateVersionDto {
  @IsBoolean()
  starred: boolean;
}

/** What restoring a version did. */
export class RestoreVersionResultDto {
  /** The version now on the project. */
  version: number;
  /** The version the replaced state was kept as (null: a version already held it). */
  savedAs: number | null;
}
