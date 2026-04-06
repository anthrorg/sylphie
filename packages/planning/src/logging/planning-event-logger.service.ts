/**
 * PlanningEventLoggerService -- Fire-and-forget event logger for the Planning subsystem.
 *
 * Writes PLANNING subsystem events to the TimescaleDB events table. All pipeline
 * steps use this service to emit observability events (opportunity intake/drop,
 * research completed, plan validated/created, etc.).
 *
 * Pattern: every INSERT is fire-and-forget. The logger catches errors internally
 * and emits a warn-level log rather than propagating. This ensures that a
 * TimescaleDB hiccup never aborts a planning cycle.
 *
 * CANON SS TimescaleDB -- The Event Backbone: Every Planning pipeline step
 * is logged here for complete traceability.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TimescaleService } from '@sylphie/shared';
import type { IPlanningEventLogger, PlanningEventType } from '../interfaces/planning.interfaces';

@Injectable()
export class PlanningEventLoggerService implements IPlanningEventLogger {
  private readonly logger = new Logger(PlanningEventLoggerService.name);

  constructor(
    private readonly timescale: TimescaleService,
  ) {}

  /**
   * Fire-and-forget: insert a PLANNING event row into TimescaleDB.
   *
   * The driveSnapshot is null for v1 -- the Planning subsystem does not have
   * direct access to the drive state reader. This is a known limitation.
   * The session_id defaults to 'planning-internal' when not supplied by the
   * calling pipeline step.
   */
  log(
    eventType: PlanningEventType,
    payload: Record<string, unknown>,
    sessionId?: string,
  ): void {
    const id = randomUUID();
    const timestamp = new Date();
    const resolvedSessionId = sessionId ?? 'planning-internal';

    this.timescale
      .query(
        `INSERT INTO events
           (id, type, timestamp, subsystem, session_id, drive_snapshot, payload, schema_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          eventType,
          timestamp,
          'PLANNING',
          resolvedSessionId,
          null,
          JSON.stringify(payload),
          1,
        ],
      )
      .catch((err: unknown) => {
        this.logger.warn(
          `Failed to log planning event (type: ${eventType}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }
}
