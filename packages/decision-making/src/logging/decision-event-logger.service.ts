/**
 * DecisionEventLoggerService — Unified event logging for the Decision Making subsystem.
 *
 * Logs all decision-making events (input categorization, candidate retrieval, prediction,
 * arbitration, execution, observation, outcome) to TimescaleDB. Implements batching for
 * efficiency: events are buffered and flushed every 10 events or 100ms.
 *
 * CANON §TimescaleDB — The Event Backbone: All decision-making events flow through this
 * service to ensure complete traceability. Every decision cycle is tagged with a cycleId
 * (UUID) for end-to-end tracing.
 *
 * Adapted from sylphie-old: Replaced EventsModule/IEventService with direct
 * TimescaleService SQL writes. Event construction is done inline rather than
 * through a separate createDecisionMakingEvent builder.
 *
 * On module destroy, any buffered events are flushed to prevent data loss.
 */

import {
  Injectable,
  OnModuleDestroy,
  Logger,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TimescaleService, type DriveSnapshot } from '@sylphie/shared';
import type { IDecisionEventLogger } from '../interfaces/decision-making.interfaces';

// ---------------------------------------------------------------------------
// Buffered Event
// ---------------------------------------------------------------------------

interface BufferedEvent {
  readonly id: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly driveSnapshot: DriveSnapshot;
  readonly sessionId: string;
  readonly correlationId?: string;
  readonly timestamp: Date;
}

// ---------------------------------------------------------------------------
// Decision Event Logger Service
// ---------------------------------------------------------------------------

@Injectable()
export class DecisionEventLoggerService implements IDecisionEventLogger, OnModuleDestroy {
  private readonly logger = new Logger(DecisionEventLoggerService.name);

  /** Local buffer of pending events. */
  private eventBuffer: BufferedEvent[] = [];

  /** Timer for periodic flush. Cleared and reset on every event. */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Flush threshold: batch size in events. */
  private readonly BATCH_SIZE = 10;

  /** Flush threshold: time in milliseconds. */
  private readonly FLUSH_INTERVAL_MS = 100;

  constructor(
    private readonly timescale: TimescaleService,
  ) {}

  /**
   * Log a decision-making event (buffered).
   *
   * Adds the event to the local buffer and schedules a flush if either:
   *   1. The buffer reaches BATCH_SIZE (10 events), or
   *   2. FLUSH_INTERVAL_MS (100ms) elapses without a new event.
   *
   * This method is synchronous and never awaits the flush.
   */
  log(
    eventType: string,
    payload: Record<string, unknown>,
    driveSnapshot: DriveSnapshot,
    sessionId: string,
    correlationId?: string,
  ): void {
    this.eventBuffer.push({
      id: randomUUID(),
      eventType,
      payload,
      driveSnapshot,
      sessionId,
      correlationId,
      timestamp: new Date(),
    });

    // Clear existing timer and restart
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
    }

    if (this.eventBuffer.length >= this.BATCH_SIZE) {
      this.flush().catch((err) => {
        this.logger.error('Failed to flush decision events (batch full):', err);
      });
    } else {
      this.flushTimer = setTimeout(() => {
        this.flush().catch((err) => {
          this.logger.error('Failed to flush decision events (timeout):', err);
        });
      }, this.FLUSH_INTERVAL_MS);
    }
  }

  /**
   * Force flush all buffered events to TimescaleDB.
   *
   * Converts each buffered event into a SQL INSERT and persists via
   * TimescaleService.query(). If TimescaleService is unavailable, events
   * are logged at warn level and discarded.
   */
  async flush(): Promise<void> {
    if (this.eventBuffer.length === 0) {
      return;
    }

    const events = this.eventBuffer.splice(0);
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.timescale) {
      this.logger.warn(
        `TimescaleService unavailable, discarding ${events.length} decision events`,
      );
      return;
    }

    this.logger.debug(`Flushing ${events.length} decision events to TimescaleDB`);

    for (const event of events) {
      try {
        await this.timescale.query(
          `INSERT INTO events (id, type, timestamp, subsystem, session_id, drive_snapshot, payload, correlation_id, schema_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            event.id,
            event.eventType,
            event.timestamp,
            'DECISION_MAKING',
            event.sessionId,
            JSON.stringify(event.driveSnapshot),
            JSON.stringify(event.payload),
            event.correlationId ?? null,
            1,
          ],
        );
      } catch (err) {
        this.logger.error(
          `Failed to record decision event (type: ${event.eventType}): ${err}`,
        );
      }
    }
  }

  /**
   * Module destroy hook: flush remaining events before shutdown.
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log('DecisionEventLoggerService shutting down, flushing final events...');

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flush();

    if (this.eventBuffer.length > 0) {
      this.logger.warn(
        `${this.eventBuffer.length} decision events were lost during shutdown`,
      );
    }

    this.logger.log('DecisionEventLoggerService shutdown complete');
  }
}
