// Writes openapi.json without starting the HTTP server or connecting to external services.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { createOpenApiDocument } from './openapi.js';

process.env.DB_HOST ??= 'localhost';
process.env.DB_USERNAME ??= 'openapi';
process.env.DB_PASSWORD ??= 'openapi';
process.env.DB_NAME ??= 'openapi';
// The app requires a JWT secret to start; nothing is signed here, so a throwaway one will do.
process.env.JWT_SECRET ??= randomBytes(48).toString('base64');

try {
  // Imported after the defaults above: a static import would validate the env first.
  const { AppModule } = await import('../app.module.js');

  // abortOnError off: a failed start throws to the catch below instead of exiting silently.
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
    abortOnError: false,
  });
  const document = createOpenApiDocument(app);
  writeFileSync('openapi.json', JSON.stringify(document, null, 2) + '\n');
  await app.close();
  console.log('Wrote openapi.json');
} catch (error) {
  // The Nest logger is off: say why, or CI only shows "exit code 1".
  console.error('Could not generate openapi.json:', error);
  process.exit(1);
}
