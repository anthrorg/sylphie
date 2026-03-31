/**
 * TimescaleInitService — TimescaleDB schema initialization and lifecycle management.
 *
 * On module init:
 * - Creates the events hypertable with idempotent DDL
 * - Creates compression and retention policies
 * - Creates all required indexes
 * - Performs health check
 *
 * On module destroy:
 * - Gracefully closes the connection pool
 *
 * CANON §TimescaleDB — The Event Backbone: All DDL is idempotent and safe
 * to run repeatedly. Pool cleanup is essential to prevent connection leaks.
 */

import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import type { AppConfig } from '../shared/config/app.config';
import { TIMESCALEDB_POOL } from './events.tokens';

@Injectable()
export class TimescaleInitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TimescaleInitService.name);

  constructor(
    @Inject(TIMESCALEDB_POOL) private readonly pool: Pool,
    private readonly config: ConfigService,
  ) {}

  /**
   * Initialize TimescaleDB schema on module load.
   * Creates hypertable, indexes, compression, and retention policies.
   * All operations are idempotent.
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('Initializing TimescaleDB schema...');

    try {
      // Run all DDL operations
      await this.createEventsTable();
      await this.createHypertable();
      await this.createIndexes();
      await this.setupCompression();
      await this.setupRetention();

      // Verify health
      await this.healthCheck();

      this.logger.log('TimescaleDB schema initialization complete');
    } catch (error) {
      this.logger.error('TimescaleDB initialization failed:', error);
      throw error;
    }
  }

  /**
   * Clean up pool connections on module destroy.
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log('Closing TimescaleDB pool...');
    try {
      await this.pool.end();
      this.logger.log('TimescaleDB pool closed');
    } catch (error) {
      this.logger.error('Error closing TimescaleDB pool:', error);
    }
  }

  /**
   * Create the events table if it doesn't exist.
   * Idempotent: safe to run multiple times.
   */
  private async createEventsTable(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const createTableSql = `
        CREATE TABLE IF NOT EXISTS events (
          event_id UUID NOT NULL DEFAULT gen_random_uuid(),
          timestamp TIMESTAMPTZ NOT NULL,
          event_type TEXT NOT NULL,
          subsystem_source TEXT NOT NULL,
          correlation_id UUID,
          actor_id TEXT DEFAULT 'sylphie',
          drive_snapshot JSONB,
          tick_number BIGINT,
          event_data JSONB NOT NULL,
          has_learnable BOOLEAN DEFAULT false,
          processed BOOLEAN DEFAULT false,
          schema_version INTEGER DEFAULT 1,
          PRIMARY KEY (event_id, timestamp)
        );
      `;
      await client.query(createTableSql);
      this.logger.debug('events table created or already exists');
    } finally {
      client.release();
    }
  }

  /**
   * Convert the events table to a hypertable partitioned by timestamp.
   * Idempotent: uses if_not_exists => TRUE.
   */
  private async createHypertable(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const hypertableSql = `
        SELECT create_hypertable('events', 'timestamp', if_not_exists => TRUE);
      `;
      await client.query(hypertableSql);
      this.logger.debug('events hypertable created or already exists');
    } finally {
      client.release();
    }
  }

  /**
   * Create all required indexes on the events table.
   * All use IF NOT EXISTS for idempotency.
   */
  private async createIndexes(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type)',
        'CREATE INDEX IF NOT EXISTS idx_events_subsystem ON events(subsystem_source)',
        'CREATE INDEX IF NOT EXISTS idx_events_learnable ON events(has_learnable) WHERE has_learnable = true',
        'CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id) WHERE correlation_id IS NOT NULL',
        'CREATE INDEX IF NOT EXISTS idx_events_composite ON events(timestamp, event_type)',
      ];

      for (const indexSql of indexes) {
        await client.query(indexSql);
      }
      this.logger.debug('All indexes created or already exist');
    } finally {
      client.release();
    }
  }

  /**
   * Set up compression policy for the events hypertable.
   * Compresses chunks older than the configured compressionDays.
   * Idempotent: uses if_not_exists => TRUE.
   */
  private async setupCompression(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const appConfig = this.config.get<AppConfig>('app');
      const compressionDays = appConfig?.timescale.compressionDays ?? 7;

      // Enable compression on the table if not already enabled
      const enableCompressionSql = `
        DO $$ BEGIN
          EXECUTE 'ALTER TABLE events SET (timescaledb.compress = true)';
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END $$;
      `;
      await client.query(enableCompressionSql);

      // Add compression policy
      const compressionPolicySql = `
        SELECT add_compression_policy('events', INTERVAL '${compressionDays} days', if_not_exists => TRUE);
      `;
      await client.query(compressionPolicySql);
      this.logger.debug(`Compression policy set for chunks older than ${compressionDays} days`);
    } finally {
      client.release();
    }
  }

  /**
   * Set up retention policy for the events hypertable.
   * Drops chunks older than the configured retentionDays.
   * Idempotent: uses if_not_exists => TRUE.
   */
  private async setupRetention(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const appConfig = this.config.get<AppConfig>('app');
      const retentionDays = appConfig?.timescale.retentionDays ?? 90;

      const retentionPolicySql = `
        SELECT add_retention_policy('events', INTERVAL '${retentionDays} days', if_not_exists => TRUE);
      `;
      await client.query(retentionPolicySql);
      this.logger.debug(`Retention policy set to ${retentionDays} days`);
    } finally {
      client.release();
    }
  }

  /**
   * Health check: verify the database connection and hypertable existence.
   * @throws Error if health check fails
   */
  async healthCheck(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Test basic connection
      const selectResult = await client.query('SELECT 1 as health_check');
      if (!selectResult.rows.length) {
        throw new Error('Health check SELECT 1 returned no rows');
      }

      // Verify events table exists and is a hypertable
      const hypertableCheckSql = `
        SELECT EXISTS(
          SELECT 1 FROM timescaledb_information.hypertables
          WHERE hypertable_name = 'events'
        ) as is_hypertable;
      `;
      const hypertableResult = await client.query(hypertableCheckSql);
      const isHypertable = hypertableResult.rows[0]?.is_hypertable;

      if (!isHypertable) {
        throw new Error('events table is not a valid hypertable');
      }

      this.logger.log('TimescaleDB health check passed');
    } finally {
      client.release();
    }
  }
}
