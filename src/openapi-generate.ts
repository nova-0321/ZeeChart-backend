// Writes openapi.json without starting the HTTP server or connecting to external services.
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { createOpenApiDocument } from './openapi.js';

const app = await NestFactory.create(AppModule, { preview: true, logger: false });
const document = createOpenApiDocument(app);
writeFileSync('openapi.json', JSON.stringify(document, null, 2) + '\n');
await app.close();
console.log('Wrote openapi.json');
