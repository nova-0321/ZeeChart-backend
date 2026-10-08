// Writes openapi.json without starting the HTTP server or connecting to external services.
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { createOpenApiDocument } from './openapi.js';

process.env.DB_HOST ??= 'localhost';
process.env.DB_USERNAME ??= 'openapi';
process.env.DB_PASSWORD ??= 'openapi';
process.env.DB_NAME ??= 'openapi';

// Imported after the defaults above: a static import would validate the env first.
const { AppModule } = await import('./app.module.js');

const app = await NestFactory.create(AppModule, { preview: true, logger: false });
const document = createOpenApiDocument(app);
writeFileSync('openapi.json', JSON.stringify(document, null, 2) + '\n');
await app.close();
console.log('Wrote openapi.json');
