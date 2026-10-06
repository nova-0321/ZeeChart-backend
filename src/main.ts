import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { createOpenApiDocument } from './openapi.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Swagger UI at /docs, raw spec at /docs-json
  SwaggerModule.setup('docs', app, () => createOpenApiDocument(app));
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
