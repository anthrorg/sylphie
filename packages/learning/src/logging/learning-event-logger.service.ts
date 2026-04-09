/**
 * LearningEventLoggerService — Fire-and-forget event logger for the Learning subsystem.
 *
 * Writes LEARNING subsystem events to the TimescaleDB events table. All pipeline
 * steps use this service to emit observability events (cycle started/completed,
 * entity extracted, edge refined, contradiction detected).
 *
 * Pattern: every INSERT is fire-and-forget. The logger catches errors internally
 * and emits a warn-level log rather than propagating. This ensures that a
 * TimescaleDB hiccup never aborts a maintenance cycle.
 *
 * CANON §TimescaleDB — The Event Backbone: Every Learning cycle and pipeline step
 * is logged here for complete traceability.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TimescaleService, verboseFor } from '@sylphie/shared';
import type { ILearningEventLogger } from '../interfaces/learning.interfaces';

const vlog = verboseFor('Learning');

@Injectable()
export class LearningEventLoggerService implements ILearningEventLogger {
  private readonly logger = new Logger(LearningEventLoggerService.name);

  constructor(
    private readonly timescale: TimescaleService,
  ) {}

  /**
   * Fire-and-forget: insert a LEARNING event row into TimescaleDB.
   *
   * The driveSnapshot is null for v1 — the Learning subsystem does not have
   * direct access to the drive state reader. This is a known limitation.
   * The session_id defaults to 'learning-internal' when not supplied by the
   * calling pipeline step.
   */
  log(
    eventType: string,
    payload: Record<string, unknown>,
    sessionId?: string,
  ): void {
    const id = randomUUID();
    const timestamp = new Date();
    const resolvedSessionId = sessionId ?? 'learning-internal';

    vlog('learning event logged', {
      eventType,
      sessionId: resolvedSessionId,
      payloadSummary: Object.fromEntries(
        Object.entries(payload).map(([k, v]) => [
          k,
          typeof v === 'string' ? v.substring(0, 60) : v,
        ]),
      ),
    });

    this.timescale
      .query(
        `INSERT INTO events
           (id, type, timestamp, subsystem, session_id, drive_snapshot, payload, schema_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          eventType,
          timestamp,
          'LEARNING',
          resolvedSessionId,
          null,
          JSON.stringify(payload),
          1,
        ],
      )
      .catch((err: unknown) => {
        this.logger.warn(
          `Failed to log learning event (type: ${eventType}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }
}
