/**
 * Event emitter for the Drive Engine child process.
 *
 * Provides a fire-and-forget interface for emitting drive-related events to
 * the batching pipeline. All methods are non-blocking — they queue the event
 * and return immediately.
 *
 * CANON §Drive Isolation: Event emission runs in the child process with its
 * own TimescaleDB connection, completely isolated from the main NestJS process.
 */
import type { DriveSnapshot, DriveName } from '../../shared/types/drive.types';
import type {
  DriveTickEvent,
  OutcomeProcessedEvent,
  OpportunityCreatedEvent,
  ContingencyAppliedEvent,
  SelfEvaluationRunEvent,
  RuleAppliedEvent,
  HealthStatusEvent,
  DriveEvent,
} from '../interfaces/drive-events';

/**
 * Interface for emitting events from the Drive Engine.
 *
 * All methods are fire-and-forget (void return, no await needed).
 * Events are queued and batched for writing to TimescaleDB.
 */
export interface IEventEmitter {
  /**
   * Emit a DRIVE_TICK event.
   *
   * High-frequency event; typically sampled to avoid flooding the event log.
   *
   * @param snapshot - The drive snapshot at this tick
   * @param tickNumber - The tick counter
   * @param ruleIds - IDs of any rules that fired
   */
  emitTick(
    snapshot: DriveSnapshot,
    tickNumber: number,
    ruleIds: string[],
  ): void;

  /**
   * Emit an OUTCOME_PROCESSED event.
   *
   * Called when an ACTION_OUTCOME is processed by the Drive Engine.
   *
   * @param snapshot - The current drive snapshot
   * @param actionId - ID of the action
   * @param actionType - Category of the action
   * @param outcome - Whether the outcome was positive or negative
   * @param appliedRuleIds - IDs of rules that were applied
   * @param driveDelta - Drive changes from this outcome
   * @param wasTheatrical - Whether the expression was theatrical
   * @param feedbackSource - Source of the feedback
   */
  emitOutcomeProcessed(
    snapshot: DriveSnapshot,
    actionId: string,
    actionType: string,
    outcome: 'positive' | 'negative',
    appliedRuleIds: string[],
    driveDelta: Partial<Record<DriveName, number>>,
    wasTheatrical: boolean,
    feedbackSource: 'guardian_confirmation' | 'guardian_correction' | 'algorithmic',
  ): void;

  /**
   * Emit an OPPORTUNITY_CREATED event.
   *
   * Called when the Drive Engine detects a pattern worth planning against.
   *
   * @param snapshot - The current drive snapshot
   * @param opportunityId - UUID of the opportunity
   * @param classification - How the opportunity was classified
   * @param priority - Initial priority (HIGH, MEDIUM, LOW)
   * @param contextFingerprint - Semantic fingerprint
   * @param affectedDrive - Primary drive affected
   * @param predictionMAE - Mean absolute error that triggered this
   */
  emitOpportunityCreated(
    snapshot: DriveSnapshot,
    opportunityId: string,
    classification:
      | 'PREDICTION_FAILURE_PATTERN'
      | 'HIGH_IMPACT_ONE_OFF'
      | 'BEHAVIORAL_NARROWING'
      | 'GUARDIAN_TEACHING',
    priority: 'HIGH' | 'MEDIUM' | 'LOW',
    contextFingerprint: string,
    affectedDrive: DriveName,
    predictionMAE: number,
  ): void;

  /**
   * Emit a CONTINGENCY_APPLIED event.
   *
   * Called when a behavioral contingency fires.
   *
   * @param snapshot - The current drive snapshot
   * @param ruleId - ID of the rule
   * @param eventType - Event type that triggered the rule
   * @param driveDelta - Drive changes from this contingency
   * @param confidence - Confidence in the contingency
   */
  emitContingency(
    snapshot: DriveSnapshot,
    ruleId: string,
    eventType: string,
    driveDelta: Partial<Record<DriveName, number>>,
    confidence: number,
  ): void;

  /**
   * Emit a SELF_EVALUATION_RUN event.
   *
   * Called when the Drive Engine runs self-evaluation.
   *
   * @param snapshot - The current drive snapshot
   * @param evaluationType - Type of evaluation (e.g., 'PREDICTION_ACCURACY')
   * @param result - Summary of the evaluation result
   * @param hasConcerns - Whether any concerns were flagged
   */
  emitSelfEvaluation(
    snapshot: DriveSnapshot,
    evaluationType: string,
    result: Record<string, unknown>,
    hasConcerns: boolean,
  ): void;

  /**
   * Emit a RULE_APPLIED event.
   *
   * Called when a Postgres drive rule is matched and applied.
   *
   * @param snapshot - The current drive snapshot
   * @param ruleId - ID of the matched rule
   * @param eventType - Event type that was looked up
   * @param driveDelta - Drive changes from this rule
   * @param isGuardianApproved - Whether the rule was guardian-approved
   */
  emitRuleApplied(
    snapshot: DriveSnapshot,
    ruleId: string,
    eventType: string,
    driveDelta: Partial<Record<DriveName, number>>,
    isGuardianApproved: boolean,
  ): void;

  /**
   * Emit a HEALTH_STATUS event.
   *
   * Periodic heartbeat for monitoring the Drive Engine process.
   *
   * @param snapshot - The current drive snapshot
   * @param tickNumber - The tick counter
   * @param memoryUsageMb - Heap memory used in MB
   * @param healthy - Whether the process is healthy
   * @param diagnosticMessage - Diagnostic message, if any
   */
  emitHealthStatus(
    snapshot: DriveSnapshot,
    tickNumber: number,
    memoryUsageMb: number,
    healthy: boolean,
    diagnosticMessage: string | null,
  ): void;

  /**
   * Flush all queued events to TimescaleDB.
   *
   * Normally called automatically by the batching timer. This is exported
   * for testing and graceful shutdown.
   *
   * @returns Promise that resolves when the batch is written (or fails).
   */
  flush(): Promise<void>;
}

/**
 * EventEmitter implementation.
 *
 * Queues events and handles batched writes to TimescaleDB with retry logic.
 * Runs in the Drive Engine child process only.
 */
export class EventEmitter implements IEventEmitter {
  private queue: DriveEvent[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly sessionId: string;
  private readonly timescaleWriter: ITimescaleWriter;
  private readonly batchSize: number;
  private readonly batchTimeoutMs: number;
  private readonly maxQueueSize: number;

  constructor(
    sessionId: string,
    timescaleWriter: ITimescaleWriter,
    options?: {
      batchSize?: number;
      batchTimeoutMs?: number;
      maxQueueSize?: number;
    },
  ) {
    this.sessionId = sessionId;
    this.timescaleWriter = timescaleWriter;
    this.batchSize = options?.batchSize ?? 50;
    this.batchTimeoutMs = options?.batchTimeoutMs ?? 100;
    this.maxQueueSize = options?.maxQueueSize ?? 10000;
  }

  /**
   * Queue an event and schedule flush if needed.
   */
  private enqueue(event: DriveEvent): void {
    // Check queue size
    if (this.queue.length >= this.maxQueueSize) {
      // Drop oldest event and warn
      const dropped = this.queue.shift();
      if (process.stderr) {
        process.stderr.write(
          `[EventEmitter] Queue overflow: dropped event ${dropped?.driveSnapshot.sessionId}\n`,
        );
      }
    }

    this.queue.push(event);

    // Schedule flush if not already scheduled
    if (!this.batchTimer) {
      this.scheduleBatchFlush();
    }

    // Flush immediately if batch size reached
    if (this.queue.length >= this.batchSize) {
      this.scheduleFlushNow();
    }
  }

  private scheduleBatchFlush(): void {
    if (this.batchTimer) {
      return;
    }

    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      // Fire and forget — we don't want to block the tick loop
      this.flush().catch((err) => {
        if (process.stderr) {
          process.stderr.write(`[EventEmitter] Batch flush error: ${err}\n`);
        }
      });
    }, this.batchTimeoutMs);
  }

  private scheduleFlushNow(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Schedule immediately on next tick
    setImmediate(() => {
      this.flush().catch((err) => {
        if (process.stderr) {
          process.stderr.write(`[EventEmitter] Immediate flush error: ${err}\n`);
        }
      });
    });
  }

  emitTick(
    snapshot: DriveSnapshot,
    tickNumber: number,
    ruleIds: string[],
  ): void {
    const event: DriveTickEvent = {
      type: 'DRIVE_TICK',
      driveSnapshot: snapshot,
      sessionId: this.sessionId,
      timestamp: new Date(),
      tickNumber,
      ruleIds,
      totalPressure: snapshot.totalPressure,
    };
    this.enqueue(event);
  }

  emitOutcomeProcessed(
    snapshot: DriveSnapshot,
    actionId: string,
    actionType: string,
    outcome: 'positive' | 'negative',
    appliedRuleIds: string[],
    driveDelta: Partial<Record<DriveName, number>>,
    wasTheatrical: boolean,
    feedbackSource: 'guardian_confirmation' | 'guardian_correction' | 'algorithmic',
  ): void {
    const event: OutcomeProcessedEvent = {
      type: 'OUTCOME_PROCESSED',
      driveSnapshot: snapshot,
      sessionId: this.sessionId,
      timestamp: new Date(),
      actionId,
      actionType,
      outcome,
      appliedRuleIds,
      driveDelta,
      wasTheatrical,
      feedbackSource,
    };
    this.enqueue(event);
  }

  emitOpportunityCreated(
    snapshot: DriveSnapshot,
    opportunityId: string,
    classification:
      | 'PREDICTION_FAILURE_PATTERN'
      | 'HIGH_IMPACT_ONE_OFF'
      | 'BEHAVIORAL_NARROWING'
      | 'GUARDIAN_TEACHING',
    priority: 'HIGH' | 'MEDIUM' | 'LOW',
    contextFingerprint: string,
    affectedDrive: DriveName,
    predictionMAE: number,
  ): void {
    const event: OpportunityCreatedEvent = {
      type: 'OPPORTUNITY_CREATED',
      driveSnapshot: snapshot,
      sessionId: this.sessionId,
      timestamp: new Date(),
      opportunityId,
      classification,
      priority,
      contextFingerprint,
      affectedDrive,
      predictionMAE,
    };
    this.enqueue(event);
  }

  emitContingency(
    snapshot: DriveSnapshot,
    ruleId: string,
    eventType: string,
    driveDelta: Partial<Record<DriveName, number>>,
    confidence: number,
  ): void {
    const event: ContingencyAppliedEvent = {
      type: 'CONTINGENCY_APPLIED',
      driveSnapshot: snapshot,
      sessionId: this.sessionId,
      timestamp: new Date(),
      ruleId,
      eventType,
      driveDelta,
      confidence,
    };
    this.enqueue(event);
  }

  emitSelfEvaluation(
    snapshot: DriveSnapshot,
    evaluationType: string,
    result: Record<string, unknown>,
    hasConcerns: boolean,
  ): void {
    const event: SelfEvaluationRunEvent = {
      type: 'SELF_EVALUATION_RUN',
      driveSnapshot: snapshot,
      sessionId: this.sessionId,
      timestamp: new Date(),
      evaluationType,
      result,
      hasConcerns,
    };
    this.enqueue(event);
  }

  emitRuleApplied(
    snapshot: DriveSnapshot,
    ruleId: string,
    eventType: string,
    driveDelta: Partial<Record<DriveName, number>>,
    isGuardianApproved: boolean,
  ): void {
    const event: RuleAppliedEvent = {
      type: 'RULE_APPLIED',
      driveSnapshot: snapshot,
      sessionId: this.sessionId,
      timestamp: new Date(),
      ruleId,
      eventType,
      driveDelta,
      isGuardianApproved,
    };
    this.enqueue(event);
  }

  emitHealthStatus(
    snapshot: DriveSnapshot,
    tickNumber: number,
    memoryUsageMb: number,
    healthy: boolean,
    diagnosticMessage: string | null,
  ): void {
    const event: HealthStatusEvent = {
      type: 'HEALTH_STATUS',
      driveSnapshot: snapshot,
      sessionId: this.sessionId,
      timestamp: new Date(),
      tickNumber,
      memoryUsageMb,
      healthy,
      diagnosticMessage,
    };
    this.enqueue(event);
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }

    // Drain current queue
    const eventsToWrite = this.queue.splice(0, this.queue.length);

    // Write to TimescaleDB
    await this.timescaleWriter.writeBatch(eventsToWrite);

    // Reschedule if more events arrived during the write
    if (this.queue.length > 0 && !this.batchTimer) {
      this.scheduleBatchFlush();
    }
  }
}

/**
 * Interface for writing events to TimescaleDB.
 * Implemented by TimescaleWriter.
 */
export interface ITimescaleWriter {
  writeBatch(events: DriveEvent[]): Promise<void>;
}
