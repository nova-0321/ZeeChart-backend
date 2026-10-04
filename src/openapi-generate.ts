// Writes openapi.json without starting the HTTP server or connecting to external services.
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { createOpenApiDocument } from './openapi.js';

// AppModule validates env vars on load (src/config/env.validation.ts). The spec
// doesn't depend on them and preview mode never connects to the database, so
// fill placeholders for anything not already set in the environment.
const PLACEHOLDER_ENV = {
  DB_HOST: 'localhost',
  DB_USERNAME: 'openapi',
  DB_PASSWORD: 'openapi',
  DB_NAME: 'openapi',
};
for (const [key, value] of Object.entries(PLACEHOLDER_ENV)) {
  process.env[key] ??= value;
}

// Imported after the env is filled: ConfigModule validates when AppModule loads.
const { AppModule } = await import('./app.module.js');

const app = await NestFactory.create(AppModule, { preview: true, logger: ['error'] });
const document = createOpenApiDocument(app);
writeFileSync('openapi.json', JSON.stringify(document, null, 2) + '\n');
await app.close();
console.warn('Wrote openapi.json');
