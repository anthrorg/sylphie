import { Controller, Get, HttpCode } from '@nestjs/common';

/**
 * HealthController — cheap container liveness probe.
 *
 * GET /api/health returns 200 immediately with NO database calls and NO heavy
 * compute. This is the path the Dockerfile HEALTHCHECK and the Railway deploy
 * healthcheck probe.
 *
 * Why a dedicated endpoint (TK-106): the Railway/Docker healthcheck previously
 * probed GET /api/metrics/health, which runs Promise.all of 7 heavy aggregations
 * (a full Neo4j WORLD graph scan over 34k+ nodes plus TimescaleDB aggregations)
 * on every call. Under decision-cycle load that exceeds the 10s healthcheck
 * timeout, the container gets marked unhealthy, and Railway de-routes all
 * traffic — producing a 502 on every endpoint while the process keeps running.
 * A liveness probe must answer that the *process is up and the event loop is
 * responsive*, nothing more. The rich 7-metric snapshot stays on
 * /api/metrics/health for the dashboard.
 */
@Controller('health')
export class HealthController {
  @Get()
  @HttpCode(200)
  live(): { status: 'ok'; uptimeSeconds: number; timestamp: string } {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
