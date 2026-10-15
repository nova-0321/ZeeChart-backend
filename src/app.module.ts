import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { HttpThrottlerGuard } from './common/http-throttler.guard.js';
import { envValidationSchema } from './config/env.validation.js';
import { throttlerOptions } from './common/throttling.js';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { AuthModule } from './auth/auth.module.js';
import { HttpLoggerMiddleware } from './common/http-logger.middleware.js';
import { EventsModule } from './events/events.module.js';
import { HealthModule } from './health/health.module.js';
import { MembersModule } from './members/members.module.js';
import { RevisionsModule } from './revisions/revisions.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { DependenciesModule } from './dependencies/dependencies.module.js';
import { DatabaseModule } from './database/database.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fail at startup, listing every missing/invalid variable, instead of a
      // confusing connection error later.
      validationSchema: envValidationSchema,
    }),
    // Rate limits per address, and sign-in tries per email (see common/throttling.ts).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: throttlerOptions,
    }),
    DatabaseModule,
    AuthModule,
    HealthModule,
    EventsModule,
    ProjectsModule,
    MembersModule,
    TasksModule,
    DependenciesModule,
    RealtimeModule,
    // After RealtimeModule: its interceptor runs inside the live one, so a change's history is
    // written before the others are told of the change.
    RevisionsModule,
  ],
  providers: [
    // Registered here (not in main.ts) so the filter can inject HttpAdapterHost.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // HTTP only: socket messages have their own limits (see HttpThrottlerGuard).
    { provide: APP_GUARD, useClass: HttpThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpLoggerMiddleware).forRoutes('*path');
  }
}
