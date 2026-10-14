import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDataSourceOptions } from './database.config.js';
import { ProjectWriteLock } from './project-write-lock.js';
import { RequestTransaction } from './request-transaction.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...buildDataSourceOptions((key) => config.get<string>(key)),
        // The app registers entities through TypeOrmModule.forFeature (autoLoadEntities).
        // The file glob in buildDataSourceOptions is only for the TypeORM CLI: it matches
        // .ts sources under vitest, which Node's ESM loader can't parse.
        entities: [],
        autoLoadEntities: true,
      }),
    }),
  ],
  providers: [RequestTransaction, ProjectWriteLock],
  exports: [RequestTransaction, ProjectWriteLock],
})
export class DatabaseModule {}
