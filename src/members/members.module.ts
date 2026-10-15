import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
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
    // AuthGuard (and the JwtService it needs), and AuthService: people are found by email.
    AuthModule,
    TypeOrmModule.forFeature([Member, Invitation]),
    // Telling people they were added or removed.
    RealtimeModule,
    // ProjectsService: a project's lock, and the name rule for a new owner.
    ProjectsModule,
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
