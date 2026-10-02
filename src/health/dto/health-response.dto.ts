export class HealthResponseDto {
  /** Always "ok" when the service is up. */
  status: 'ok';
  /** Process uptime in seconds. */
  uptime: number;
  /** Server time (ISO 8601). */
  timestamp: string;
}
