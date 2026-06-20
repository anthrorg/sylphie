/**
 * UpdateWkgService — Step 2 of the Learning maintenance cycle.
 *
 * Responsibilities:
 *   1. Schema migration: add has_learned BOOLEAN DEFAULT false to the events
 *      table and create a partial index WHERE has_learned = false.
 *   2. Ensure the failed_learning_events dead-letter hypertable exists.
 *   3. Fetch up to N unlearned events from TimescaleDB (ordered ASC by timestamp
 *      so the oldest experience is processed first).
 *   4. Mark individual events as learned after the full pipeline completes.
 *   5. Write dead-letter rows when a pipeline step throws.
 *
 * CANON §Subsystem 3 (Learning): "Max 5 learnable events per cycle." The caller
 * (LearningService) passes the limit; this service does not enforce the constant.
 *
 * Event types we process:
 *   INPUT_RECEIVED — raw user text, payload.content is the text.
 *   INPUT_PARSED   — structured parse result, payload.entities is a string[].
 * Both come from the COMMUNICATION subsystem and represent conversation events
 * that carry learnable content.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TimescaleService, verboseFor } from '@sylphie/shared';
import type {
  IUpdateWkgService,
  UnlearnedEvent,
} from '../interfaces/learning.interfaces';

const vlog = verboseFor('Learning');

@Injectable()
export class UpdateWkgService implements IUpdateWkgService, OnModuleInit {
  private readonly logger = new Logger(UpdateWkgService.name);

  constructor(
    private readonly timescale: TimescaleService,
  ) {}

  // ---------------------------------------------------------------------------
  // OnModuleInit: run schema migration
  // ---------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    await this.ensureSchema();
    await this.ensureDeadLetterSchema();
  }

  // ---------------------------------------------------------------------------
  // IUpdateWkgService implementation
  // ---------------------------------------------------------------------------

  /**
   * Ensure the has_learned column exists on the events table.
   *
   * Uses IF NOT EXISTS / conditional DDL patterns so this is fully idempotent.
   * The partial index (WHERE has_learned = false) keeps queries fast even when
   * the events table grows to millions of rows — only unprocessed rows appear in
   * the index.
   */
  async ensureSchema(): Promise<void> {
    try {
      // Add column if missing. DO NOTHING on conflict means it is idempotent.
      await this.timescale.query(`
        ALTER TABLE events
          ADD COLUMN IF NOT EXISTS has_learned BOOLEAN NOT NULL DEFAULT false
      `);

      // Partial index for efficient unlearned-event queries.
      // CREATE INDEX IF NOT EXISTS is idempotent.
      await this.timescale.query(`
        CREATE INDEX IF NOT EXISTS idx_events_unlearned
          ON events (timestamp ASC)
          WHERE has_learned = false
      `);

      this.logger.log('Learning schema migration complete (has_learned column + index)');
    } catch (err) {
      this.logger.error(
        `Learning schema migration failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Do not rethrow — a migration failure should not prevent the app from starting.
      // The cycle will fail gracefully when TimescaleDB queries return errors.
    }
  }

  /**
   * Ensure the failed_learning_events dead-letter hypertable exists.
   *
   * TimescaleDB hypertables require the table to be created first, then
   * create_hypertable() is called. The hypertable call is wrapped in a
   * DO block so it is idempotent (raises no error on subsequent runs).
   *
   * retry_count defaults to 0; future retrying logic can increment it.
   */
  async ensureDeadLetterSchema(): Promise<void> {
    try {
      await this.timescale.query(`
        CREATE TABLE IF NOT EXISTS failed_learning_events (
          event_id       TEXT        NOT NULL,
          pipeline_step  TEXT        NOT NULL,
          error_message  TEXT        NOT NULL,
          retry_count    INTEGER     NOT NULL DEFAULT 0,
          failed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // Make failed_at the hypertable dimension so dead-letter rows can be
      // time-partitioned and queried efficiently alongside the events table.
      await this.timescale.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM timescaledb_information.hypertables
             WHERE hypertable_name = 'failed_learning_events'
          ) THEN
            PERFORM create_hypertable('failed_learning_events', 'failed_at');
          END IF;
        END
        $$
      `);

      this.logger.log('Dead-letter schema migration complete (failed_learning_events hypertable)');
    } catch (err) {
      this.logger.error(
        `Dead-letter schema migration failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Do not rethrow — a migration failure must not prevent the app from starting.
    }
  }

  /**
   * Fetch up to `limit` unprocessed events.
   *
   * Only selects events with learnable content:
   *   INPUT_RECEIVED — payload.content is the raw user text.
   *   INPUT_PARSED   — payload.entities is the parsed entity list.
   *
   * Ordered by timestamp ASC: oldest experience is consolidated first,
   * which matches CANON's intent that learning is continuous and cumulative.
   */
  async fetchUnlearnedEvents(limit: number): Promise<UnlearnedEvent[]> {
    try {
      const result = await this.timescale.query<UnlearnedEvent>(
        `SELECT id, type, timestamp, subsystem, session_id, payload, schema_version
         FROM events
         WHERE has_learned = false
           AND type IN ('INPUT_RECEIVED', 'INPUT_PARSED')
         ORDER BY timestamp ASC
         LIMIT $1`,
        [limit],
      );

      vlog('unlearned events fetched', {
        count: result.rows.length,
        limit,
        types: [...new Set(result.rows.map((e) => e.type))],
      });

      return result.rows;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vlog('fetchUnlearnedEvents error', { error: message });
      this.logger.error(`fetchUnlearnedEvents failed: ${message}`);
      return [];
    }
  }

  /**
   * Mark a single event as learned so it is excluded from future cycles.
   */
  async markAsLearned(eventId: string): Promise<void> {
    try {
      await this.timescale.query(
        `UPDATE events SET has_learned = true WHERE id = $1`,
        [eventId],
      );
      vlog('event marked as learned', { eventId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vlog('markAsLearned error', { eventId, error: message });
      this.logger.error(`markAsLearned failed for event ${eventId}: ${message}`);
    }
  }

  /**
   * Record a failed pipeline event to the dead-letter table.
   *
   * Called from the processEvent() catch block so silent data loss becomes
   * auditable. Errors are swallowed here — a dead-letter write failure must
   * never cascade into a secondary failure or prevent markAsLearned().
   */
  async writeDeadLetter(
    eventId: string,
    pipelineStep: string,
    errorMessage: string,
  ): Promise<void> {
    try {
      await this.timescale.query(
        `INSERT INTO failed_learning_events
           (event_id, pipeline_step, error_message, retry_count, failed_at)
         VALUES ($1, $2, $3, 0, NOW())`,
        [eventId, pipelineStep, errorMessage],
      );
      vlog('dead-letter row written', { eventId, pipelineStep });
    } catch (err) {
      // Swallow: a dead-letter write failure must not block markAsLearned().
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`writeDeadLetter failed for event ${eventId}: ${message}`);
    }
  }
}
