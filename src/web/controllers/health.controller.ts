import { Controller, Get, Res, Inject, Logger } from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { DatabaseHealthService, type HealthCheckResponse } from '../services/database-health.service';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import type { HealthCheckResponse as HealthCheckResponseDto } from '../dtos/health.dto';
import type { HealthCheckResult } from '../dtos/health.dto';
import type { WebConfig } from '../web.config';

/**
 * HealthController — Liveness and readiness probes.
 *
 * Exposes a single GET /api/health route that returns detailed health
 * status for all five databases (Neo4j, TimescaleDB, PostgreSQL, Self KG, Other KG).
 *
 * Returns 200 if aggregate status is "healthy" or "degraded", 503 if "unhealthy".
 *
 * Features:
 * - Per-check 150ms timeout to prevent slow databases from blocking the response
 * - Overall 500ms timeout for the entire health check operation
 * - System metadata: uptime and version
 * - Response caching (30s TTL) for non-degraded status
 * - HEALTH_CHECK_COMPLETED events recorded to TimescaleDB
 */
@Controller('api/health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private lastCachedResponse: HealthCheckResponseDto | null = null;
  private lastCacheTimestamp: number = 0;
  private cacheTtlMs: number = 30000;

  constructor(
    private readonly databaseHealthService: DatabaseHealthService,
    private readonly configService: ConfigService,
    @Inject(EVENTS_SERVICE) private readonly eventService: IEventService,
  ) {
    const webConfig = this.configService.get<WebConfig>('web');
    this.cacheTtlMs = webConfig?.healthCheck.cacheTtlMs ?? 30000;
  }

  /**
   * Check system health across all databases.
   *
   * Returns JSON with per-database status, latency measurements, system uptime,
   * and version information.
   *
   * HTTP status codes:
   * - 200: At least one database is healthy (status is "healthy" or "degraded")
   * - 503: All databases are unhealthy (status is "unhealthy")
   *
   * Response is cached for 30 seconds for non-degraded status to reduce load.
   */
  @Get()
  async check(@Res() res: Response): Promise<void> {
    // Check cache for healthy status
    const now = Date.now();
    if (
      this.lastCachedResponse &&
      this.lastCachedResponse.status === 'healthy' &&
      now - this.lastCacheTimestamp < this.cacheTtlMs
    ) {
      const statusCode = 200;
      res.status(statusCode).json(this.lastCachedResponse);
      return;
    }

    // Perform the health check
    const rawHealth = await this.databaseHealthService.checkAll();

    // Transform to DTO format with system metadata
    const timestamp = Date.now();
    const uptime = process.uptime();
    const version = '0.1.0';

    const databases: HealthCheckResult[] = [
      {
        database: 'Neo4j',
        status: rawHealth.databases.neo4j.status,
        latencyMs: rawHealth.databases.neo4j.latencyMs,
        error: rawHealth.databases.neo4j.error,
      },
      {
        database: 'TimescaleDB',
        status: rawHealth.databases.timescaledb.status,
        latencyMs: rawHealth.databases.timescaledb.latencyMs,
        error: rawHealth.databases.timescaledb.error,
      },
      {
        database: 'PostgreSQL',
        status: rawHealth.databases.postgres.status,
        latencyMs: rawHealth.databases.postgres.latencyMs,
        error: rawHealth.databases.postgres.error,
      },
      {
        database: 'Self KG',
        status: rawHealth.databases.selfKg.status,
        latencyMs: rawHealth.databases.selfKg.latencyMs,
        error: rawHealth.databases.selfKg.error,
      },
      {
        database: 'Other KG',
        status: rawHealth.databases.otherKg.status,
        latencyMs: rawHealth.databases.otherKg.latencyMs,
        error: rawHealth.databases.otherKg.error,
      },
    ];

    // Compute aggregate status with rollup rules
    const healthyCount = databases.filter((db) => db.status === 'healthy').length;
    const slowCount = databases.filter((db) => db.latencyMs > 200).length;
    const unreachableCount = databases.filter((db) => db.status === 'unhealthy').length;

    let aggregateStatus: 'healthy' | 'degraded' | 'unhealthy' = 'unhealthy';
    if (unreachableCount === 0) {
      if (healthyCount === 5 && slowCount === 0) {
        aggregateStatus = 'healthy';
      } else {
        aggregateStatus = 'degraded';
      }
    }

    const response: HealthCheckResponseDto = {
      status: aggregateStatus,
      databases,
      uptime,
      version,
      timestamp,
    };

    // Cache only if healthy
    if (aggregateStatus === 'healthy') {
      this.lastCachedResponse = response;
      this.lastCacheTimestamp = now;
    }

    // Record event to TimescaleDB
    try {
      // Create a minimal drive snapshot for health check event recording
      await this.eventService.record({
        type: 'HEALTH_CHECK_COMPLETED',
        subsystem: 'WEB',
        sessionId: 'system-health-check',
        driveSnapshot: {
          pressureVector: {
            systemHealth: 0.2,
            moralValence: 0.2,
            integrity: 0.2,
            cognitiveAwareness: 0.2,
            guilt: 0.0,
            curiosity: 0.3,
            boredom: 0.4,
            anxiety: 0.2,
            satisfaction: 0.0,
            sadness: 0.0,
            informationIntegrity: 0.1,
            social: 0.5,
          },
          timestamp: new Date(),
          tickNumber: 0,
          driveDeltas: {
            systemHealth: 0.0,
            moralValence: 0.0,
            integrity: 0.0,
            cognitiveAwareness: 0.0,
            guilt: 0.0,
            curiosity: 0.0,
            boredom: 0.0,
            anxiety: 0.0,
            satisfaction: 0.0,
            sadness: 0.0,
            informationIntegrity: 0.0,
            social: 0.0,
          },
          ruleMatchResult: {
            ruleId: null,
            eventType: 'HEALTH_CHECK_COMPLETED',
            matched: false,
          },
          totalPressure: 2.5,
          sessionId: 'system-health-check',
        },
        schemaVersion: 1,
      });
    } catch (error) {
      // Log error but don't fail the health check response
      this.logger.error('Failed to record HEALTH_CHECK_COMPLETED event:', error);
    }

    // Set HTTP status code based on aggregate health status
    const statusCode = aggregateStatus === 'unhealthy' ? 503 : 200;
    res.status(statusCode).json(response);
  }
}

