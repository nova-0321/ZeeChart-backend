import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envValidationSchema } from './config/env.validation.js';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { HttpLoggerMiddleware } from './common/http-logger.middleware.js';
import { EventsModule } from './events/events.module.js';
import { HealthModule } from './health/health.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { TaskModule } from './tasks/task.module.js';
import { DatabaseModule } from './database/database.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fail at startup, listing every missing/invalid variable, instead of a
      // confusing connection error later.
      validationSchema: envValidationSchema,
    }),
    DatabaseModule,
    HealthModule,
    EventsModule,
    ProjectsModule,
    TaskModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Registered here (not in main.ts) so the filter can inject HttpAdapterHost.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpLoggerMiddleware).forRoutes('*path');
  }
}
