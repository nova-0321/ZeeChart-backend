import { SetMetadata } from '@nestjs/common';
import type { ProjectLocator } from '../projects/project-access.js';
import type { RealtimeAction, RealtimeEntity } from './realtime.types.js';

// Marks a write route: after it succeeds, everyone with its project open is told (see
// BroadcastInterceptor). Every POST / PATCH / PUT / DELETE route carries @Broadcast or
// @NoBroadcast; a test fails otherwise, so a new route can't forget it.
//
// How a route finds its project is shared with the access check (projects/project-access.ts): the
// same locators, so the project a change is announced to is the one whose members were checked.

export type { ProjectLocator };
export { projectInBody, projectInParam, projectOfRow } from '../projects/project-access.js';

export interface BroadcastOptions {
  entity: RealtimeEntity;
  action: Exclude<RealtimeAction, 'resync'>;
  project: ProjectLocator;
  /**
   * false: the message never carries the changed rows (a restore puts back a whole plan or a row's
   * past: whoever has the project open loads it again). See RowChanges.
   */
  rows?: false;
}

export const BROADCAST = 'realtime:broadcast';
export const NO_BROADCAST = 'realtime:no-broadcast';

export const Broadcast = (options: BroadcastOptions) => SetMetadata(BROADCAST, options);

/** A write route that deliberately tells no one (the reason is for the reader). */
export const NoBroadcast = (reason: string) => SetMetadata(NO_BROADCAST, reason);
