/**
 * TimescaleDB writer for Drive Engine events.
 *
 * Handles batched writes to TimescaleDB with retry logic.
 * Runs in the Drive Engine child process with its own database connection.
 *
 * CANON §Drive Isolation: The child process has its own TimescaleDB connection
 * and never uses shared database pools from the main NestJS process.
 */

import { Pool, PoolClient } from 'pg';
import { verboseFor } from '@sylphie/shared';
import type { DriveEvent } from '../interfaces/drive-events';
import {
  RETRY_COUNT,
  RETRY_BASE_DELAY_MS,
} from '../constants/events';

const vlog = verboseFor('DriveEngine');

/**
 * TimescaleDB event writer for the Drive Engine child process.
 *
 * Creates and manages a dedicated pg.Pool connection to TimescaleDB.
 * All database operations are isolated from the main NestJS process.
 */
export class TimescaleWriter {
  private pool: Pool;
  private isReady: boolean = false;

  constructor(config: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    maxConnections?: number;
  }) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: config.maxConnections ?? 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // Emit error events to stderr (not thrown to avoid crashing the process)
    this.pool.on('error', (err) => {
      if (process.stderr) {
        process.stderr.write(`[TimescaleWriter] Pool error: ${err}\n`);
      }
    });
  }

  /**
   * Initialize the connection pool with a test query.
   *
   * Verifies TimescaleDB is reachable and accessible.
   *
   * @throws {Error} If the test query fails
   */
  async init(): Promise<void> {
    try {
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
        this.isReady = true;
      } finally {
        client.release();
      }
    } catch (err) {
      if (process.stderr) {
        process.stderr.write(`[TimescaleWriter] Init failed: ${err}\n`);
      }
      throw err;
    }
  }

  /**
   * Write a batch of events to TimescaleDB with retry logic.
   *
   * Attempts to insert the batch up to RETRY_COUNT times with exponential
   * backoff. If all retries fail, logs the error and returns (non-blocking).
   *
   * @param events - The events to write
   */
  async writeBatch(events: DriveEvent[]): Promise<void> {
    if (!this.isReady) {
      if (process.stderr) {
        process.stderr.write(
          `[TimescaleWriter] Not ready; discarding ${events.length} events\n`,
        );
      }
      return;
    }

    if (events.length === 0) {
      return;
    }

    vlog('timescale write batch', { batchSize: events.length, eventTypes: events.map(e => e.type) });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
      try {
        await this.writeBatchWithoutRetry(events);
        vlog('timescale write success', { batchSize: events.length, attempt: attempt + 1 });
        return; // Success
      } catch (err) {
        lastError = err as Error;

        // If this wasn't the last attempt, wait before retrying
        if (attempt < RETRY_COUNT - 1) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    // All retries exhausted
    vlog('timescale write failed', {
      batchSize: events.length,
      retries: RETRY_COUNT,
      error: lastError?.message,
    });
    if (process.stderr) {
      process.stderr.write(
        `[TimescaleWriter] Failed after ${RETRY_COUNT} attempts: ${lastError?.message}\n`,
      );
    }
  }

  /**
   * Write a batch without retry logic.
   *
   * Constructs a parameterized multi-value INSERT and executes it.
   * All events in the batch are written in a single transaction.
   *
   * @param events - The events to write
   * @throws {Error} If the query fails
   */
  private async writeBatchWithoutRetry(events: DriveEvent[]): Promise<void> {
    let client: PoolClient | null = null;

    try {
      client = await this.pool.connect();

      // Build parameterized multi-value INSERT
      const { sql, params } = this.buildInsertQuery(events);

      await client.query(sql, params);
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Build a parameterized INSERT query for a batch of events.
   *
   * Returns a SQL string and parameter array suitable for pool.query().
   * Uses the generic events table schema from EventsService.
   *
   * @param events - Events to insert
   * @returns { sql, params } for parameterized query
   */
  private buildInsertQuery(events: DriveEvent[]): { sql: string; params: any[] } {
    const params: any[] = [];
    const valueStrings: string[] = [];

    // Map drive event types to canonical EventType values
    events.forEach((event, index) => {
      const baseIndex = index * 8; // 8 columns per event

      // event_id (UUID v4)
      const eventId = this.generateUUID();
      params.push(eventId);

      // timestamp (ISO 8601)
      params.push(event.timestamp);

      // event_type (enum EventType)
      params.push(event.type);

      // subsystem_source (always 'DRIVE_ENGINE' for these events)
      params.push('DRIVE_ENGINE');

      // correlation_id (NULL for now; could be added later)
      params.push(null);

      // drive_snapshot (JSONB)
      params.push(JSON.stringify(event.driveSnapshot));

      // event_data (JSONB - the rest of the event payload)
      const eventData = this.extractEventData(event);
      params.push(JSON.stringify(eventData));

      // schema_version (1 for Drive Engine events)
      params.push(1);

      valueStrings.push(
        `($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, ` +
          `$${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8})`,
      );
    });

    const sql = `
      INSERT INTO events (
        event_id,
        timestamp,
        event_type,
        subsystem_source,
        correlation_id,
        drive_snapshot,
        event_data,
        schema_version
      )
      VALUES ${valueStrings.join(', ')}
      ON CONFLICT (event_id) DO NOTHING
    `;

    return { sql, params };
  }

  /**
   * Extract event-specific data for the JSONB payload.
   *
   * Removes driveSnapshot and sessionId (already in separate columns)
   * and returns the rest of the event properties.
   *
   * @param event - The Drive Engine event
   * @returns The event_data JSONB payload
   */
  private extractEventData(event: DriveEvent): Record<string, any> {
    const {
      driveSnapshot,
      sessionId,
      timestamp,
      type,
      ...rest
    } = event as any;

    return {
      sessionId,
      ...rest,
    };
  }

  /**
   * Generate a UUID v4.
   *
   * Simple implementation using Math.random(). For production use,
   * would normally import from uuid package, but to minimize dependencies
   * in the child process, using this simple version.
   */
  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Sleep for a specified number of milliseconds.
   *
   * Used for retry backoff.
   *
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Gracefully close the connection pool.
   *
   * Called during shutdown.
   */
  async close(): Promise<void> {
    try {
      await this.pool.end();
    } catch (err) {
      if (process.stderr) {
        process.stderr.write(`[TimescaleWriter] Close error: ${err}\n`);
      }
    }
  }
}
