import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { User } from '../auth/entities/user.entity.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { Invitation } from './entities/invitation.entity.js';
import { Member } from './entities/member.entity.js';
import {
  InvitationsController,
  InviteLinksController,
  MembersController,
  ProjectInvitationsController,
  ProjectMembersController,
} from './members.controller.js';
import { MembersService } from './members.service.js';

/** Who is in a project, with which role (owner / editor / viewer; see member-role.ts). */
@Module({
  imports: [
    // AuthGuard (and the JwtService it needs).
    AuthModule,
    TypeOrmModule.forFeature([Member, Invitation, User]),
    // Telling people they were added or removed.
    RealtimeModule,
  ],
  controllers: [
    ProjectMembersController,
    MembersController,
    ProjectInvitationsController,
    InvitationsController,
    InviteLinksController,
  ],
  providers: [MembersService],
})
export class MembersModule {}
