/**
 * TimescaleDB writer for Drive Engine state persistence.
 *
 * Manages a dedicated pg.Pool connection to TimescaleDB used to save/restore
 * the drive-state checkpoint across restarts. Runs in the Drive Engine child
 * process with its own database connection.
 *
 * CANON §Drive Isolation: The child process has its own TimescaleDB connection
 * and never uses shared database pools from the main NestJS process.
 *
 * TK-133 (2026-07): this previously also batch-wrote DriveEvents directly to
 * the shared `events` table (writeBatch/buildInsertQuery), but that path's
 * INSERT column list did not match infra/timescaledb/init/002-events.sql
 * (event_id/subsystem_source/event_data vs the schema's id/subsystem/payload,
 * and it omitted the NOT NULL session_id) — and it was unreachable in
 * practice because the only consumer, EventEmitter, was never instantiated
 * (dead code, confirmed: no production caller). Removed rather than fixed:
 * DriveProcessManagerService (packages/drive-engine/src/drive-process/
 * drive-process-manager.service.ts) already forwards OPPORTUNITY_CREATED /
 * DRIVE_EVENT / THEATER_PROHIBITED over IPC and persists them to `events`
 * from the main process with the CORRECT columns — a second, child-side
 * direct writer would have double-written the same events.
 */

import { Pool } from 'pg';
import { verboseFor } from '@sylphie/shared';

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

  // -------------------------------------------------------------------------
  // Drive state persistence — save/restore across restarts
  // -------------------------------------------------------------------------

  /**
   * Save the current drive state snapshot to a dedicated persistence row.
   *
   * Uses an UPSERT keyed on a fixed sentinel ID ('drive_state_checkpoint')
   * so there is always exactly one row. Called on graceful shutdown.
   */
  async saveState(pressureVector: Record<string, number>, tickNumber: number): Promise<void> {
    if (!this.isReady) return;

    try {
      const client = await this.pool.connect();
      try {
        await client.query(
          `INSERT INTO drive_state_checkpoint (id, pressure_vector, tick_number, saved_at)
           VALUES ('latest', $1, $2, NOW())
           ON CONFLICT (id) DO UPDATE SET
             pressure_vector = $1,
             tick_number = $2,
             saved_at = NOW()`,
          [JSON.stringify(pressureVector), tickNumber],
        );
        vlog('drive state saved', { tickNumber });
      } finally {
        client.release();
      }
    } catch (err) {
      if (process.stderr) {
        process.stderr.write(`[TimescaleWriter] saveState failed: ${err}\n`);
      }
    }
  }

  /**
   * Load the most recently saved drive state from TimescaleDB.
   *
   * Returns null if no checkpoint exists (true cold start).
   * Called once at startup before the tick loop begins.
   */
  async loadState(): Promise<{ pressureVector: Record<string, number>; tickNumber: number } | null> {
    if (!this.isReady) return null;

    try {
      const client = await this.pool.connect();
      try {
        const result = await client.query(
          `SELECT pressure_vector, tick_number FROM drive_state_checkpoint WHERE id = 'latest'`,
        );
        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        const pressureVector = typeof row.pressure_vector === 'string'
          ? JSON.parse(row.pressure_vector)
          : row.pressure_vector;
        const tickNumber = typeof row.tick_number === 'number'
          ? row.tick_number
          : parseInt(row.tick_number, 10) || 0;

        vlog('drive state loaded', { tickNumber, drives: Object.keys(pressureVector).length });
        return { pressureVector, tickNumber };
      } finally {
        client.release();
      }
    } catch (err) {
      // Table may not exist yet — that's fine, it's a cold start
      if (process.stderr) {
        process.stderr.write(`[TimescaleWriter] loadState failed (cold start): ${err}\n`);
      }
      return null;
    }
  }

  /**
   * Ensure the drive_state_checkpoint table exists.
   * Called once during init().
   */
  async ensureCheckpointTable(): Promise<void> {
    if (!this.isReady) return;

    try {
      const client = await this.pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS drive_state_checkpoint (
            id TEXT PRIMARY KEY,
            pressure_vector JSONB NOT NULL,
            tick_number INTEGER NOT NULL DEFAULT 0,
            saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
      } finally {
        client.release();
      }
    } catch (err) {
      if (process.stderr) {
        process.stderr.write(`[TimescaleWriter] ensureCheckpointTable failed: ${err}\n`);
      }
    }
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
