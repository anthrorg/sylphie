/**
 * UpdateWkgService — Step 2 of the Learning maintenance cycle.
 *
 * Responsibilities:
 *   1. Schema migration: add has_learned BOOLEAN DEFAULT false to the events
 *      table and create a partial index WHERE has_learned = false.
 *   2. Fetch up to N unlearned events from TimescaleDB (ordered ASC by timestamp
 *      so the oldest experience is processed first).
 *   3. Mark individual events as learned after the full pipeline completes.
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
}
