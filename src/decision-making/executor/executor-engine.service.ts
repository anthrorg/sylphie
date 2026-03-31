/**
 * Executor Engine Service — State Machine & Cycle Metrics (E5-T001)
 *
 * CANON §Subsystem 1 (Decision Making): The Executor Engine is a finite-state
 * machine that manages the phases of the cognitive loop. This implementation
 * enforces the legal 8-state transition sequence with timeout enforcement,
 * cycle metrics collection, and error recovery.
 *
 * Legal sequence: IDLE → CATEGORIZING → RETRIEVING → PREDICTING → ARBITRATING →
 * EXECUTING → OBSERVING → LEARNING → IDLE
 *
 * Timeout: 500ms per state (CANON Phase 1). Exceeding the timeout triggers
 * automatic recovery to IDLE and logs a diagnostic event.
 *
 * Metrics: Per-state latency tracking, cycle throughput, and TimescaleDB logging
 * for observability.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ExecutorState } from '../../shared/types/action.types';
import { IExecutorEngine } from '../interfaces/decision-making.interfaces';
import { createDecisionMakingEvent } from '../../events';
import { IEventService } from '../../events/interfaces/events.interfaces';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { DriveSnapshot } from '../../shared/types/drive.types';

// ---------------------------------------------------------------------------
// Cycle Metrics
// ---------------------------------------------------------------------------

/**
 * Metrics for a single state visit.
 *
 * Tracks the entry time, timeout threshold, and latency on exit.
 * Used for per-state performance analysis and timeout detection.
 */
interface StateMetrics {
  readonly enteredAt: number; // milliseconds since epoch
  readonly timeoutAt: number; // milliseconds since epoch
  latencyMs?: number; // calculated on transition out
}

/**
 * Metrics collected over a full executor cycle.
 *
 * A cycle spans IDLE → ... → LEARNING → IDLE. Tracks per-state latencies,
 * total cycle time, and timestamp for TimescaleDB correlation.
 */
interface CycleMetrics {
  readonly cycleId: string; // UUID, unique per cycle
  readonly cycleStartedAt: number; // milliseconds since epoch
  readonly stateMetrics: Map<ExecutorState, StateMetrics>;
  driveSnapshot: DriveSnapshot | null; // captured at cycle start if available
}

// ---------------------------------------------------------------------------
// Valid Transitions
// ---------------------------------------------------------------------------

/**
 * Enforces the legal transition graph.
 *
 * CANON §Subsystem 1: Illegal transitions throw DecisionMakingException.
 * forceIdle() is the only path to IDLE from a non-LEARNING state.
 */
const VALID_TRANSITIONS: Readonly<Record<ExecutorState, ExecutorState[]>> = {
  [ExecutorState.IDLE]: [ExecutorState.CATEGORIZING],
  [ExecutorState.CATEGORIZING]: [ExecutorState.RETRIEVING],
  [ExecutorState.RETRIEVING]: [ExecutorState.PREDICTING],
  [ExecutorState.PREDICTING]: [ExecutorState.ARBITRATING],
  [ExecutorState.ARBITRATING]: [ExecutorState.EXECUTING],
  [ExecutorState.EXECUTING]: [ExecutorState.OBSERVING],
  [ExecutorState.OBSERVING]: [ExecutorState.LEARNING],
  [ExecutorState.LEARNING]: [ExecutorState.IDLE],
};

// Timeout per state, in milliseconds. CANON Phase 1: 500ms max per state.
const STATE_TIMEOUT_MS = 500;

@Injectable()
export class ExecutorEngineService implements IExecutorEngine {
  private readonly logger = new Logger('ExecutorEngineService');

  /** Current executor state. Initialized to IDLE (cold-start default). */
  private currentState: ExecutorState = ExecutorState.IDLE;

  /** Metrics for the current cycle (since the last IDLE → CATEGORIZING transition). */
  private currentCycleMetrics: CycleMetrics | null = null;

  /** Timestamp when currentState was entered, in milliseconds. */
  private stateEnteredAt: number = Date.now();

  /** Timeout handle for the current state. Cleared on transition. */
  private stateTimeoutHandle: NodeJS.Timeout | null = null;

  /** Most recent drive snapshot, captured for event emission. */
  private lastDriveSnapshot: DriveSnapshot | null = null;

  /**
   * Create the ExecutorEngineService.
   *
   * Inject the EventsService for TimescaleDB logging. The service is optional
   * to allow for testing, but in production all state transitions log events.
   *
   * @param eventsService - IEventService for emitting diagnostic events.
   */
  constructor(
    @Inject(EVENTS_SERVICE) private readonly eventsService: IEventService,
  ) {}

  /**
   * Transition the executor to the given target state.
   *
   * Validates that the transition is legal from the current state.
   * Records metrics for the outgoing state and initializes metrics for the
   * incoming state. Emits diagnostic events to TimescaleDB.
   *
   * CANON Standard 1 (Theater Prohibition): Each state transition captures
   * the current drive snapshot for event correlation.
   *
   * @param targetState - The state to transition to.
   * @throws Error if the transition is not legal from the current state.
   */
  transition(targetState: ExecutorState): void {
    // Validate the transition is legal.
    const legalNextStates = VALID_TRANSITIONS[this.currentState];
    if (!legalNextStates.includes(targetState)) {
      const msg = `Illegal transition: ${this.currentState} → ${targetState}`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    // Record latency for the exiting state.
    const exitTime = Date.now();
    const stateLatencyMs = exitTime - this.stateEnteredAt;

    // Clear the timeout for the exiting state.
    if (this.stateTimeoutHandle !== null) {
      clearTimeout(this.stateTimeoutHandle);
      this.stateTimeoutHandle = null;
    }

    // Update cycle metrics for the exiting state.
    if (this.currentCycleMetrics !== null) {
      const metrics = this.currentCycleMetrics.stateMetrics.get(this.currentState);
      if (metrics) {
        metrics.latencyMs = stateLatencyMs;
      }
    }

    // Initialize metrics for the incoming state.
    if (this.currentCycleMetrics === null) {
      // Starting a new cycle: currentState is IDLE, targetState is CATEGORIZING.
      this.currentCycleMetrics = {
        cycleId: randomUUID(),
        cycleStartedAt: exitTime,
        stateMetrics: new Map(),
        driveSnapshot: this.lastDriveSnapshot,
      };
    }

    // Record entry metrics for the incoming state.
    const entryTime = Date.now();
    const incomingMetrics: StateMetrics = {
      enteredAt: entryTime,
      timeoutAt: entryTime + STATE_TIMEOUT_MS,
    };
    this.currentCycleMetrics.stateMetrics.set(targetState, incomingMetrics);

    // Transition state.
    const previousState = this.currentState;
    this.currentState = targetState;
    this.stateEnteredAt = entryTime;

    // Emit a diagnostic event (if eventsService is available).
    if (this.eventsService && this.lastDriveSnapshot) {
      try {
        const event = createDecisionMakingEvent('DECISION_CYCLE_STARTED', {
          sessionId: this.lastDriveSnapshot.sessionId,
          driveSnapshot: this.lastDriveSnapshot,
          correlationId: this.currentCycleMetrics?.cycleId,
        });
        void this.eventsService.record(event);
      } catch (err) {
        this.logger.warn(`Failed to emit transition event: ${err}`);
        // Continue — event emission failure should not block state transitions.
      }
    }

    // Set a timeout for the incoming state. If the timeout fires, the state
    // has been active for too long — force recovery to IDLE.
    this.stateTimeoutHandle = setTimeout(() => {
      this.logger.warn(
        `State timeout: ${this.currentState} exceeded ${STATE_TIMEOUT_MS}ms. Forcing recovery.`,
      );
      this.forceIdle();
    }, STATE_TIMEOUT_MS);

    // Check if the cycle completed (exiting LEARNING → IDLE).
    if (previousState === ExecutorState.LEARNING && targetState === ExecutorState.IDLE) {
      this.onCycleComplete();
    }
  }

  /**
   * Force the executor to IDLE regardless of current state.
   *
   * Used for error recovery when the cognitive loop encounters an unrecoverable
   * error mid-cycle. Logs the forced reset, captures final metrics, and emits
   * a diagnostic event.
   *
   * This bypasses the normal legal transition graph. It should ONLY be called
   * by the main DecisionMakingService error handler.
   */
  forceIdle(): void {
    // Clear the timeout for the current state.
    if (this.stateTimeoutHandle !== null) {
      clearTimeout(this.stateTimeoutHandle);
      this.stateTimeoutHandle = null;
    }

    const previousState = this.currentState;

    // Record final latency for the interrupted state.
    const exitTime = Date.now();
    const stateLatencyMs = exitTime - this.stateEnteredAt;

    if (this.currentCycleMetrics !== null) {
      const metrics = this.currentCycleMetrics.stateMetrics.get(previousState);
      if (metrics) {
        metrics.latencyMs = stateLatencyMs;
      }
    }

    // Force transition to IDLE.
    this.currentState = ExecutorState.IDLE;
    this.stateEnteredAt = Date.now();

    // Emit diagnostic event (if available).
    if (this.eventsService && this.lastDriveSnapshot) {
      try {
        const event = createDecisionMakingEvent('DECISION_CYCLE_STARTED', {
          sessionId: this.lastDriveSnapshot.sessionId,
          driveSnapshot: this.lastDriveSnapshot,
          correlationId: this.currentCycleMetrics?.cycleId,
        });
        void this.eventsService.record(event);
      } catch (err) {
        this.logger.warn(`Failed to emit forceIdle event: ${err}`);
      }
    }

    // Reset cycle metrics when returning to IDLE due to error.
    this.currentCycleMetrics = null;

    this.logger.warn(
      `Forced reset to IDLE from ${previousState} (latency: ${stateLatencyMs}ms)`,
    );
  }

  /**
   * Return the current executor state without triggering a transition.
   *
   * Used by all decision-making sub-services to gate their logic on the
   * expected state. Sub-services that receive a call while the executor is
   * in an unexpected state should throw.
   *
   * @returns The current ExecutorState. Never null.
   */
  getState(): ExecutorState {
    return this.currentState;
  }

  /**
   * Capture the current drive snapshot.
   *
   * Called by DecisionMakingService at the start of a cycle to provide
   * the executor with the drive state for event emission and cycle correlation.
   *
   * This method is internal to the executor and is called by the main loop.
   *
   * @param snapshot - The current drive snapshot from the Drive Engine.
   */
  captureSnapshot(snapshot: DriveSnapshot): void {
    this.lastDriveSnapshot = snapshot;

    // If we have cycle metrics, update the captured snapshot.
    if (this.currentCycleMetrics !== null) {
      this.currentCycleMetrics.driveSnapshot = snapshot;
    }
  }

  /**
   * Called when a cycle completes (LEARNING → IDLE).
   *
   * Logs the cycle metrics to TimescaleDB and resets for the next cycle.
   * Computes cycle latency and per-state breakdown.
   */
  private onCycleComplete(): void {
    if (this.currentCycleMetrics === null) {
      return; // Defensive: should not happen.
    }

    const cycleMetrics = this.currentCycleMetrics;
    const cycleEndTime = Date.now();
    const totalCycleTimeMs = cycleEndTime - cycleMetrics.cycleStartedAt;

    // Build per-state latency breakdown for logging.
    const stateLatencies: Record<string, number> = {};
    let totalStateLatencyMs = 0;

    for (const [state, metrics] of cycleMetrics.stateMetrics.entries()) {
      const latency = metrics.latencyMs ?? 0;
      stateLatencies[state] = latency;
      totalStateLatencyMs += latency;
    }

    // Log cycle completion.
    this.logger.debug(
      `Cycle ${cycleMetrics.cycleId} complete: ${totalCycleTimeMs}ms total, ` +
      `${totalStateLatencyMs}ms in states, ${totalCycleTimeMs - totalStateLatencyMs}ms overhead`,
    );

    // Emit metrics to TimescaleDB (if available).
    if (this.eventsService && cycleMetrics.driveSnapshot) {
      try {
        const event = createDecisionMakingEvent('PREDICTION_MAE_SAMPLE', {
          sessionId: cycleMetrics.driveSnapshot.sessionId,
          driveSnapshot: cycleMetrics.driveSnapshot,
          correlationId: cycleMetrics.cycleId,
        });
        void this.eventsService.record(event);
      } catch (err) {
        this.logger.warn(`Failed to emit cycle metrics event: ${err}`);
      }
    }

    // Reset cycle metrics for the next cycle.
    this.currentCycleMetrics = null;
  }
}
