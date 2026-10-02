import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

// Single source of the API contract. The frontend generates its types from this.
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('ZeeChart API')
    .setVersion('0.0.1')
    .build();

  return SwaggerModule.createDocument(app, config, {
    // Stable, readable operationIds, e.g. HealthController_check -> "check"
    operationIdFactory: (_controllerKey, methodKey) => methodKey,
  });
}
