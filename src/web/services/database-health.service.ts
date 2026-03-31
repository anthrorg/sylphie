/**
 * DatabaseHealthService — comprehensive health checking for all five databases.
 *
 * Injects tokens from all database modules and provides per-database health checks.
 * Measures latency for each check independently so one slow database doesn't
 * block others.
 *
 * Aggregate status:
 * - "healthy" if all databases pass
 * - "degraded" if some pass but not all
 * - "unhealthy" if none pass or critical databases fail
 */

import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { Neo4jInitService } from '../../knowledge/neo4j-init.service';
import { TimescaleInitService } from '../../events/timescale-init.service';
import { POSTGRES_RUNTIME_POOL } from '../../database/database.tokens';
import { SELF_KG_SERVICE, OTHER_KG_SERVICE } from '../../knowledge/knowledge.tokens';
import type { ISelfKgService, IOtherKgService } from '../../knowledge/interfaces/knowledge.interfaces';

/**
 * Per-database health status.
 */
export interface DatabaseHealthStatus {
  status: 'healthy' | 'unhealthy';
  latencyMs: number;
  error?: string;
}

/**
 * Aggregate health response.
 */
export interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  databases: {
    neo4j: DatabaseHealthStatus;
    timescaledb: DatabaseHealthStatus;
    postgres: DatabaseHealthStatus;
    selfKg: DatabaseHealthStatus;
    otherKg: DatabaseHealthStatus;
  };
}

@Injectable()
export class DatabaseHealthService {
  private readonly logger = new Logger(DatabaseHealthService.name);

  constructor(
    private readonly neo4jInitService: Neo4jInitService,
    private readonly timescaleInitService: TimescaleInitService,
    @Inject(POSTGRES_RUNTIME_POOL) private readonly postgresPool: Pool,
    @Inject(SELF_KG_SERVICE) private readonly selfKgService: ISelfKgService,
    @Inject(OTHER_KG_SERVICE) private readonly otherKgService: IOtherKgService,
  ) {}

  /**
   * Check all databases and return aggregate health status.
   *
   * Each database is checked independently in parallel. If any check throws,
   * it is caught and logged, and the database is marked unhealthy.
   * This ensures one bad database doesn't prevent checking others.
   */
  async checkAll(): Promise<HealthCheckResponse> {
    this.logger.debug('Starting comprehensive health check...');

    // Run all checks in parallel
    const [neo4jStatus, timescaleStatus, postgresStatus, selfKgStatus, otherKgStatus] =
      await Promise.all([
        this.checkNeo4j(),
        this.checkTimescale(),
        this.checkPostgres(),
        this.checkSelfKg(),
        this.checkOtherKg(),
      ]);

    // Determine aggregate status
    const allStatuses = [neo4jStatus, timescaleStatus, postgresStatus, selfKgStatus, otherKgStatus];
    const healthyCount = allStatuses.filter((s) => s.status === 'healthy').length;
    const aggregateStatus: 'healthy' | 'degraded' | 'unhealthy' =
      healthyCount === 5 ? 'healthy' : healthyCount > 0 ? 'degraded' : 'unhealthy';

    this.logger.log(
      `Health check complete: ${aggregateStatus} (${healthyCount}/5 databases healthy)`,
    );

    return {
      status: aggregateStatus,
      timestamp: new Date().toISOString(),
      databases: {
        neo4j: neo4jStatus,
        timescaledb: timescaleStatus,
        postgres: postgresStatus,
        selfKg: selfKgStatus,
        otherKg: otherKgStatus,
      },
    };
  }

  /**
   * Check Neo4j connectivity and schema.
   */
  private async checkNeo4j(): Promise<DatabaseHealthStatus> {
    const startTime = Date.now();

    try {
      await this.neo4jInitService.healthCheck();
      const latencyMs = Date.now() - startTime;

      this.logger.debug(`Neo4j health check passed (${latencyMs}ms)`);
      return { status: 'healthy', latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.warn(`Neo4j health check failed: ${errorMessage}`);
      return {
        status: 'unhealthy',
        latencyMs,
        error: errorMessage,
      };
    }
  }

  /**
   * Check TimescaleDB connectivity and hypertable existence.
   */
  private async checkTimescale(): Promise<DatabaseHealthStatus> {
    const startTime = Date.now();

    try {
      await this.timescaleInitService.healthCheck();
      const latencyMs = Date.now() - startTime;

      this.logger.debug(`TimescaleDB health check passed (${latencyMs}ms)`);
      return { status: 'healthy', latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.warn(`TimescaleDB health check failed: ${errorMessage}`);
      return {
        status: 'unhealthy',
        latencyMs,
        error: errorMessage,
      };
    }
  }

  /**
   * Check PostgreSQL connectivity with a simple SELECT 1 query.
   */
  private async checkPostgres(): Promise<DatabaseHealthStatus> {
    const startTime = Date.now();

    const client = await this.postgresPool.connect();
    try {
      const result = await client.query('SELECT 1 as health_check');
      const latencyMs = Date.now() - startTime;

      if (!result.rows.length) {
        throw new Error('PostgreSQL health check returned no rows');
      }

      this.logger.debug(`PostgreSQL health check passed (${latencyMs}ms)`);
      return { status: 'healthy', latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.warn(`PostgreSQL health check failed: ${errorMessage}`);
      return {
        status: 'unhealthy',
        latencyMs,
        error: errorMessage,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Check Self KG (Grafeo) health.
   */
  private async checkSelfKg(): Promise<DatabaseHealthStatus> {
    const startTime = Date.now();

    try {
      const isHealthy = await this.selfKgService.healthCheck();
      const latencyMs = Date.now() - startTime;

      if (!isHealthy) {
        throw new Error('Self KG health check returned false');
      }

      this.logger.debug(`Self KG health check passed (${latencyMs}ms)`);
      return { status: 'healthy', latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.warn(`Self KG health check failed: ${errorMessage}`);
      return {
        status: 'unhealthy',
        latencyMs,
        error: errorMessage,
      };
    }
  }

  /**
   * Check Other KG (Grafeo) service health.
   *
   * This checks the general service health (directory accessibility),
   * not a specific person's KG.
   */
  private async checkOtherKg(): Promise<DatabaseHealthStatus> {
    const startTime = Date.now();

    try {
      const isHealthy = await this.otherKgService.healthCheck();
      const latencyMs = Date.now() - startTime;

      if (!isHealthy) {
        throw new Error('Other KG health check returned false');
      }

      this.logger.debug(`Other KG health check passed (${latencyMs}ms)`);
      return { status: 'healthy', latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.logger.warn(`Other KG health check failed: ${errorMessage}`);
      return {
        status: 'unhealthy',
        latencyMs,
        error: errorMessage,
      };
    }
  }
}
