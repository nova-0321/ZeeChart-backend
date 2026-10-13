import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { createOpenApiDocument } from './openapi/openapi.js';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureProxy } from './common/proxy.js';
import { ConfiguredIoAdapter } from './realtime/socket-io.adapter.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);
  // Behind Render's proxy: the caller's address, not the proxy's, for the rate limits.
  configureProxy(app, config);
  app.enableCors({ origin: config.get<string>('CORS_ORIGIN') });
  // Live updates (socket.io) on the same port, allowed from the same origin.
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, config.get<string>('CORS_ORIGIN')));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Swagger UI at /docs, raw spec at /docs-json
  SwaggerModule.setup('docs', app, () => createOpenApiDocument(app));
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
