import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { createOpenApiDocument } from './openapi.js';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfiguredIoAdapter } from './realtime/socket-io.adapter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  app.enableCors({ origin: config.get<string>('CORS_ORIGIN') });
  // Live updates (socket.io) on the same port, allowed from the same origin.
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, config.get<string>('CORS_ORIGIN')));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Swagger UI at /docs, raw spec at /docs-json
  SwaggerModule.setup('docs', app, () => createOpenApiDocument(app));
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
