import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthResponseDto } from './dto/health-response.dto.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponseDto {
    return {
      status: 'ok',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
