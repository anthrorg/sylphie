/**
 * StartupVerificationService — validates database health at application startup.
 *
 * Implements OnApplicationBootstrap to run after all modules are initialized.
 * Logs a verification checklist for all five databases.
 *
 * Does NOT crash the app if databases are unreachable — allows the development
 * app to start even if databases aren't running. In production, this logic
 * could be hardened to fail fast.
 */

import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { DatabaseHealthService, type HealthCheckResponse } from './database-health.service';

@Injectable()
export class StartupVerificationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StartupVerificationService.name);

  constructor(private readonly databaseHealthService: DatabaseHealthService) {}

  /**
   * Run verification after all modules are initialized.
   */
  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('Starting startup verification checklist...');

    try {
      const health = await this.databaseHealthService.checkAll();
      this.logVerificationChecklist(health);

      if (health.status === 'unhealthy') {
        this.logger.error(
          'WARNING: All databases are unreachable. The app will continue but with degraded functionality.',
        );
      } else if (health.status === 'degraded') {
        this.logger.warn(
          `WARNING: Some databases are unreachable (${
            Object.values(health.databases).filter((db) => db.status === 'healthy').length
          }/5 healthy). Check logs for details.`,
        );
      } else {
        this.logger.log('All databases verified healthy.');
      }
    } catch (error) {
      this.logger.error(
        `Startup verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.logger.error('The app will continue but database access may be unavailable.');
    }
  }

  /**
   * Log a detailed verification checklist.
   */
  private logVerificationChecklist(health: HealthCheckResponse): void {
    const timestamp = new Date(health.timestamp).toLocaleString();

    this.logger.log('========== STARTUP VERIFICATION CHECKLIST ==========');
    this.logger.log(`Timestamp: ${timestamp}`);
    this.logger.log(`Overall Status: ${health.status.toUpperCase()}`);
    this.logger.log('');

    // Checklist items
    const checks = [
      {
        name: '1. Neo4j reachable + constraints present',
        database: health.databases.neo4j,
      },
      {
        name: '2. TimescaleDB reachable + events hypertable exists',
        database: health.databases.timescaledb,
      },
      {
        name: '3. PostgreSQL reachable + RLS active',
        database: health.databases.postgres,
      },
      {
        name: '4. Self KG (Grafeo) initialized',
        database: health.databases.selfKg,
      },
      {
        name: '5. Other KG (Grafeo) service ready',
        database: health.databases.otherKg,
      },
    ];

    for (const check of checks) {
      const status = check.database.status === 'healthy' ? 'PASS' : 'FAIL';
      const latency = `${check.database.latencyMs}ms`;
      const error = check.database.error ? ` (${check.database.error})` : '';

      this.logger.log(`  [${status}] ${check.name} (${latency})${error}`);
    }

    this.logger.log('====================================================');
  }
}
