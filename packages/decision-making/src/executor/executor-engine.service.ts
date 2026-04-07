/**
 * Executor Engine Service — State Machine & Cycle Metrics
 *
 * CANON §Subsystem 1 (Decision Making): The Executor Engine is a finite-state
 * machine that manages the phases of the cognitive loop. This implementation
 * enforces the legal 8-state transition sequence with timeout enforcement,
 * cycle metrics collection, and error recovery.
 *
 * Legal sequence: IDLE -> CATEGORIZING -> RETRIEVING -> PREDICTING -> ARBITRATING ->
 * EXECUTING -> OBSERVING -> LEARNING -> IDLE
 *
 * Timeout: 500ms per state (CANON Phase 1). Exceeding the timeout triggers
 * automatic recovery to IDLE and logs a diagnostic event.
 *
 * Metrics: Per-state latency tracking, cycle throughput, and TimescaleDB logging
 * for observability.
 *
 * Adapted from sylphie-old: Replaced EventsModule injection with
 * DECISION_EVENT_LOGGER token for direct TimescaleDB writes.
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ExecutorState, type DriveSnapshot } from '@sylphie/shared';
import type { IExecutorEngine, IDecisionEventLogger } from '../interfaces/decision-making.interfaces';
import { DECISION_EVENT_LOGGER } from '../decision-making.tokens';

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
  readonly enteredAt: number;
  readonly timeoutAt: number;
  latencyMs?: number;
}

/**
 * Metrics collected over a full executor cycle.
 *
 * A cycle spans IDLE -> ... -> LEARNING -> IDLE. Tracks per-state latencies,
 * total cycle time, and timestamp for TimescaleDB correlation.
 */
interface CycleMetrics {
  readonly cycleId: string;
  readonly cycleStartedAt: number;
  readonly stateMetrics: Map<ExecutorState, StateMetrics>;
  driveSnapshot: DriveSnapshot | null;
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

/** Default timeout per state, in milliseconds. CANON Phase 1: 500ms for most states. */
const STATE_TIMEOUT_MS = 500;

/**
 * EXECUTING state gets a longer timeout because it may invoke the LLM via
 * Ollama, which can take several seconds. 30s is generous but prevents
 * genuinely hung calls from blocking the executor forever.
 */
const EXECUTING_TIMEOUT_MS = 30_000;

/** Returns the appropriate timeout for a given state. */
function getTimeoutForState(state: ExecutorState): number {
  return state === ExecutorState.EXECUTING ? EXECUTING_TIMEOUT_MS : STATE_TIMEOUT_MS;
}

@Injectable()
export class ExecutorEngineService implements IExecutorEngine {
  private readonly logger = new Logger(ExecutorEngineService.name);

  /** Current executor state. Initialized to IDLE (cold-start default). */
  private currentState: ExecutorState = ExecutorState.IDLE;

  /** Metrics for the current cycle (since the last IDLE -> CATEGORIZING transition). */
  private currentCycleMetrics: CycleMetrics | null = null;

  /** Timestamp when currentState was entered, in milliseconds. */
  private stateEnteredAt: number = Date.now();

  /** Timeout handle for the current state. Cleared on transition. */
  private stateTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  /** Most recent drive snapshot, captured for event emission. */
  private lastDriveSnapshot: DriveSnapshot | null = null;

  constructor(
    @Optional()
    @Inject(DECISION_EVENT_LOGGER)
    private readonly eventLogger: IDecisionEventLogger | null,
  ) {}

  /**
   * Transition the executor to the given target state.
   *
   * Validates that the transition is legal from the current state.
   * Records metrics for the outgoing state and initializes metrics for the
   * incoming state. Emits diagnostic events to TimescaleDB.
   *
   * @param targetState - The state to transition to.
   * Logs a warning if the transition is out-of-order but proceeds anyway.
   */
  transition(targetState: ExecutorState): void {
    const legalNextStates = VALID_TRANSITIONS[this.currentState];
    if (!legalNextStates.includes(targetState)) {
      this.logger.warn(
        `Out-of-order transition: ${this.currentState} -> ${targetState} (allowed: ${legalNextStates.join(', ')}). Proceeding anyway.`,
      );
    }

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

    // Initialize cycle metrics on first transition out of IDLE.
    if (this.currentCycleMetrics === null) {
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
      timeoutAt: entryTime + getTimeoutForState(targetState),
    };
    this.currentCycleMetrics.stateMetrics.set(targetState, incomingMetrics);

    // Transition state.
    const previousState = this.currentState;
    this.currentState = targetState;
    this.stateEnteredAt = entryTime;

    // Emit a diagnostic event.
    if (this.eventLogger && this.lastDriveSnapshot) {
      try {
        this.eventLogger.log(
          'DECISION_CYCLE_STARTED',
          {
            previousState,
            targetState,
            stateLatencyMs,
            cycleId: this.currentCycleMetrics.cycleId,
          },
          this.lastDriveSnapshot,
          this.lastDriveSnapshot.sessionId,
          this.currentCycleMetrics.cycleId,
        );
      } catch (err) {
        this.logger.warn(`Failed to emit transition event: ${err}`);
      }
    }

    // Set a timeout for the incoming state (except IDLE — no timeout on rest state).
    if (targetState !== ExecutorState.IDLE) {
      this.stateTimeoutHandle = setTimeout(() => {
        this.logger.warn(
          `State timeout: ${this.currentState} exceeded ${getTimeoutForState(this.currentState)}ms. Forcing recovery.`,
        );
        this.forceIdle();
      }, getTimeoutForState(targetState));
    }

    // Check if the cycle completed (LEARNING -> IDLE).
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
   */
  forceIdle(): void {
    if (this.stateTimeoutHandle !== null) {
      clearTimeout(this.stateTimeoutHandle);
      this.stateTimeoutHandle = null;
    }

    const previousState = this.currentState;
    const exitTime = Date.now();
    const stateLatencyMs = exitTime - this.stateEnteredAt;

    if (this.currentCycleMetrics !== null) {
      const metrics = this.currentCycleMetrics.stateMetrics.get(previousState);
      if (metrics) {
        metrics.latencyMs = stateLatencyMs;
      }
    }

    this.currentState = ExecutorState.IDLE;
    this.stateEnteredAt = Date.now();

    if (this.eventLogger && this.lastDriveSnapshot) {
      try {
        this.eventLogger.log(
          'DECISION_CYCLE_STARTED',
          {
            previousState,
            targetState: ExecutorState.IDLE,
            forced: true,
            stateLatencyMs,
            cycleId: this.currentCycleMetrics?.cycleId,
          },
          this.lastDriveSnapshot,
          this.lastDriveSnapshot.sessionId,
          this.currentCycleMetrics?.cycleId,
        );
      } catch (err) {
        this.logger.warn(`Failed to emit forceIdle event: ${err}`);
      }
    }

    this.currentCycleMetrics = null;

    this.logger.warn(
      `Forced reset to IDLE from ${previousState} (latency: ${stateLatencyMs}ms)`,
    );
  }

  /** Return the current executor state without triggering a transition. */
  getState(): ExecutorState {
    return this.currentState;
  }

  /** Capture a drive snapshot for correlation with the current cycle. */
  captureSnapshot(snapshot: DriveSnapshot): void {
    this.lastDriveSnapshot = snapshot;
    if (this.currentCycleMetrics !== null) {
      this.currentCycleMetrics.driveSnapshot = snapshot;
    }
  }

  /** Return the drive snapshot captured for the current cycle. */
  getCycleSnapshot(): DriveSnapshot | undefined {
    return this.lastDriveSnapshot ?? undefined;
  }

  /**
   * Called when a cycle completes (LEARNING -> IDLE).
   *
   * Logs the cycle metrics to TimescaleDB and resets for the next cycle.
   */
  private onCycleComplete(): void {
    if (this.currentCycleMetrics === null) {
      return;
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

    this.logger.debug(
      `Cycle ${cycleMetrics.cycleId} complete: ${totalCycleTimeMs}ms total, ` +
        `${totalStateLatencyMs}ms in states, ${totalCycleTimeMs - totalStateLatencyMs}ms overhead`,
    );

    // Emit cycle metrics event.
    if (this.eventLogger && cycleMetrics.driveSnapshot) {
      try {
        this.eventLogger.log(
          'PREDICTION_MAE_SAMPLE',
          {
            cycleId: cycleMetrics.cycleId,
            totalCycleTimeMs,
            totalStateLatencyMs,
            overheadMs: totalCycleTimeMs - totalStateLatencyMs,
            stateLatencies,
          },
          cycleMetrics.driveSnapshot,
          cycleMetrics.driveSnapshot.sessionId,
          cycleMetrics.cycleId,
        );
      } catch (err) {
        this.logger.warn(`Failed to emit cycle metrics event: ${err}`);
      }
    }

    this.currentCycleMetrics = null;
  }
}
