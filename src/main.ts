import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureProxy } from './common/proxy.js';
import { configureSecurity } from './common/security.js';
import { ConfiguredIoAdapter } from './realtime/socket-io.adapter.js';
import { createValidationPipe } from './common/validation.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);
  // Behind Render's proxy: the caller's address, not the proxy's, for the rate limits.
  configureProxy(app, config);
  app.enableCors({ origin: config.get<string>('CORS_ORIGIN') });
  // Live updates (socket.io) on the same port, allowed from the same origin.
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, config.get<string>('CORS_ORIGIN')));
  app.useGlobalPipes(createValidationPipe());
  // Security headers, and the API docs where API_DOCS allows (see common/security.ts).
  configureSecurity(app, config);
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
