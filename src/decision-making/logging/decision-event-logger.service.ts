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
 * The service buffers events locally and flushes to TimescaleDB via IEventService. This
 * reduces database round-trips while maintaining ordering guarantees (FIFO per buffer).
 *
 * On module destroy, any buffered events are flushed to prevent data loss.
 */

import {
  Injectable,
  Inject,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import type { IEventService } from '../../events/interfaces/events.interfaces';
import { createDecisionMakingEvent, type EventBuildOptions } from '../../events/builders';
import type { EventType, SylphieEvent } from '../../shared/types/event.types';
import type { ExecutorState } from '../../shared/types/action.types';
import type { DriveSnapshot } from '../../shared/types/drive.types';

// ---------------------------------------------------------------------------
// Decision Event Type
// ---------------------------------------------------------------------------

/**
 * A decision-making event to be logged.
 *
 * All events include the cycle ID (UUID), timestamp, state (the ExecutorState
 * during which the event occurred), and a generic payload for event-specific data.
 *
 * The service is responsible for converting these into proper SylphieEvent records
 * and persisting them via IEventService.
 */
export interface DecisionEvent {
  /** UUID unique to this 8-state decision cycle, for end-to-end tracing. */
  readonly cycleId: string;

  /** Wall-clock time this event was recorded. */
  readonly timestamp: Date;

  /**
   * The ExecutorState during which this event occurred.
   * One of: IDLE, CATEGORIZING, RETRIEVING, PREDICTING, ARBITRATING, EXECUTING, OBSERVING, LEARNING.
   */
  readonly state: ExecutorState;

  /**
   * The event type (e.g., DECISION_CYCLE_STARTED, PREDICTION_CREATED, ACTION_EXECUTED).
   * Must be a DecisionMaking event type per EVENT_BOUNDARY_MAP.
   */
  readonly eventType: EventType;

  /**
   * Event-specific structured data. Interpreted by consumers based on eventType.
   * Examples:
   *   - DECISION_CYCLE_STARTED: { input: string, inputType: string }
   *   - PREDICTION_CREATED: { predictionId: string, predictions: Record<string, number> }
   *   - ACTION_EXECUTED: { actionId: string, actionType: string }
   *   - PREDICTION_EVALUATED: { predictionId: string, absoluteError: number, accurate: boolean }
   */
  readonly payload: Record<string, unknown>;

  /** Session identifier for correlating events across a single interaction session. */
  readonly sessionId: string;

  /**
   * Drive state snapshot at the time this event was recorded.
   * CANON Standard 1 (Theater Prohibition) requires this on all events.
   */
  readonly driveSnapshot: DriveSnapshot;

  /**
   * Optional correlation ID for chaining events (e.g., linking ACTION_EXECUTED
   * to subsequent PREDICTION_EVALUATED events).
   */
  readonly correlationId?: string;
}

// ---------------------------------------------------------------------------
// Decision Event Logger Service
// ---------------------------------------------------------------------------

/**
 * Logs decision-making events to TimescaleDB with buffering and batching.
 *
 * CANON §TimescaleDB — The Event Backbone: Every decision-making subsystem step
 * (input, categorization, candidates, prediction, arbitration, action, outcome)
 * logs to TimescaleDB for complete audit trail and post-hoc analysis.
 *
 * Buffering strategy:
 *   - Events are collected in this.eventBuffer.
 *   - Flush triggers: 10 events OR 100ms timeout (whichever comes first).
 *   - Prevents excessive database round-trips while maintaining low latency for
 *     individual logEvent() calls.
 *
 * On module destroy, remaining buffered events are flushed to prevent data loss.
 */
@Injectable()
export class DecisionEventLoggerService implements OnModuleDestroy {
  private readonly logger = new Logger(DecisionEventLoggerService.name);

  /** Local buffer of pending events. */
  private eventBuffer: DecisionEvent[] = [];

  /** Timer for periodic flush. Cleared and reset on every event. */
  private flushTimer: NodeJS.Timeout | null = null;

  /** Flush threshold: batch size in events. */
  private readonly BATCH_SIZE = 10;

  /** Flush threshold: time in milliseconds. */
  private readonly FLUSH_INTERVAL_MS = 100;

  constructor(@Inject(EVENTS_SERVICE) private readonly eventsService: IEventService) {}

  /**
   * Log a decision event (buffered).
   *
   * Adds the event to the local buffer and schedules a flush if either:
   *   1. The buffer reaches BATCH_SIZE (10 events), or
   *   2. FLUSH_INTERVAL_MS (100ms) elapses without a new event.
   *
   * This method is synchronous and never awaits the flush. Callers continue
   * immediately; background flush happens asynchronously.
   *
   * @param event - The decision event to log
   */
  logEvent(event: DecisionEvent): void {
    this.eventBuffer.push(event);

    // Clear existing timer and restart
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
    }

    // Check if buffer is full; if so, flush immediately
    if (this.eventBuffer.length >= this.BATCH_SIZE) {
      // Fire async flush without awaiting
      this.flush().catch((err) => {
        this.logger.error('Failed to flush decision events (batch full):', err);
      });
    } else {
      // Schedule flush after timeout
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
   * Converts each buffered DecisionEvent to a proper SylphieEvent and persists
   * via IEventService.record(). Clears the buffer and cancels any pending timer.
   *
   * If any individual event fails, the error is logged but the flush continues.
   * This prevents a single bad event from blocking others.
   *
   * @throws No errors are thrown; all failures are logged to this.logger.
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

    this.logger.debug(`Flushing ${events.length} decision events to TimescaleDB`);

    for (const event of events) {
      try {
        // Build event builder options. The eventType is validated by the caller
        // (ExecutorEngine) to be a valid DecisionMaking event type.
        // Pass cycleId, state, and the caller-supplied payload through data so
        // buildEvent spreads them onto the persisted record automatically.
        const builderOpts: EventBuildOptions = {
          sessionId: event.sessionId,
          driveSnapshot: event.driveSnapshot,
          correlationId: event.correlationId,
          data: {
            cycleId: event.cycleId,
            state: event.state,
            ...event.payload,
          },
        };

        // Create the event with type assertion. Safe because the caller ensures
        // eventType belongs to DecisionMaking subsystem.
        const sylphieEvent = createDecisionMakingEvent(
          event.eventType as Parameters<typeof createDecisionMakingEvent>[0],
          builderOpts,
        );

        await this.eventsService.record(sylphieEvent);
      } catch (err) {
        this.logger.error(
          `Failed to record decision event (type: ${event.eventType}, cycleId: ${event.cycleId}):`,
          err,
        );
      }
    }
  }

  /**
   * Query decision traces by cycle ID.
   *
   * Returns all events for a single decision cycle in timestamp order (oldest first).
   * Useful for post-hoc analysis of a complete decision.
   *
   * @param cycleId - UUID of the decision cycle
   * @returns Events from the specified cycle, ordered by timestamp ascending
   */
  async queryByCycleId(cycleId: string): Promise<readonly SylphieEvent[]> {
    // Query events where data.cycleId matches
    const events = await this.eventsService.query({
      subsystems: ['DECISION_MAKING'],
      limit: 1000, // Allow large cycles
    });

    // Filter by cycleId in the data field
    return events.filter((evt) => {
      const data = evt as any;
      return data?.data?.cycleId === cycleId;
    });
  }

  /**
   * Query decision events by time range.
   *
   * Returns all decision-making events within the specified time window.
   * Used for analyzing decision patterns over time periods.
   *
   * @param start - Start of time range (inclusive)
   * @param end - End of time range (inclusive)
   * @returns Events in the time range, ordered by timestamp ascending
   */
  async queryByTimeRange(start: Date, end: Date): Promise<readonly SylphieEvent[]> {
    return this.eventsService.query({
      subsystems: ['DECISION_MAKING'],
      startTime: start,
      endTime: end,
      limit: 10000,
    });
  }

  /**
   * Query decision events by executor state.
   *
   * Returns all events that occurred during a specific executor state.
   * Useful for analyzing what happens in a particular phase (e.g., all events
   * that occur during ARBITRATING state).
   *
   * @param state - The ExecutorState to filter by
   * @returns Events from the specified state
   */
  async queryByState(state: ExecutorState): Promise<readonly SylphieEvent[]> {
    // Query all decision-making events and filter by state in data field
    const events = await this.eventsService.query({
      subsystems: ['DECISION_MAKING'],
      limit: 10000,
    });

    return events.filter((evt) => {
      const data = evt as any;
      return data?.data?.state === state;
    });
  }

  /**
   * Module destroy hook: flush remaining events before shutdown.
   *
   * Called automatically by NestJS when the application is shutting down.
   * Ensures no buffered events are lost.
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log('DecisionEventLoggerService shutting down, flushing final events...');

    // Clear timer and flush remaining events
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
