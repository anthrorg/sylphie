/**
 * Drive Engine event payload types.
 *
 * Defines the shape of each event type emitted by the Drive Engine child process.
 * These are internal to the process; they are serialized and written to TimescaleDB
 * by the event emission pipeline.
 *
 * CANON §Subsystem 4 (Drive Engine): All drive-related events are emitted from the
 * isolated child process to TimescaleDB for audit, analysis, and cross-subsystem
 * correlation.
 */

import type { DriveSnapshot, DriveName } from '@sylphie/shared';

/**
 * Base shape for all Drive Engine events.
 *
 * Every Drive Engine event includes the snapshot of drive state at the time
 * the event was emitted. This is required by CANON Standard 1 (Theater Prohibition)
 * for correlating drive state with output/behavior at audit time.
 */
export interface BaseDriveEvent {
  /** Drive state at the moment this event was created. */
  readonly driveSnapshot: DriveSnapshot;

  /** Session ID for correlating events across a session. */
  readonly sessionId: string;

  /** Wall-clock timestamp when this event was created. */
  readonly timestamp: Date;
}

/**
 * DRIVE_TICK event: A high-frequency snapshot of drive computation.
 *
 * Emitted after every tick, but typically SAMPLED (e.g., every 100th tick)
 * to avoid flooding TimescaleDB. Includes the rules that fired in this tick
 * and the deltas for each drive.
 */
export interface DriveTickEvent extends BaseDriveEvent {
  readonly type: 'DRIVE_TICK';

  /** The monotonically increasing tick number. */
  readonly tickNumber: number;

  /**
   * IDs of any rules that matched and fired in this tick.
   * Empty array if no rules matched.
   */
  readonly ruleIds: string[];

  /** Total pressure across all drives (sum of positive values). */
  readonly totalPressure: number;
}

/**
 * OUTCOME_PROCESSED event: An action outcome was applied to drive state.
 *
 * Emitted when the Drive Engine processes an ACTION_OUTCOME from the main process.
 * Includes the action that was evaluated and the resulting drive changes.
 */
export interface OutcomeProcessedEvent extends BaseDriveEvent {
  readonly type: 'OUTCOME_PROCESSED';

  /** ID of the action whose outcome was processed. */
  readonly actionId: string;

  /** Category of the action (for diversity tracking). */
  readonly actionType: string;

  /**
   * Whether the outcome was positive (action succeeded) or negative (failed).
   */
  readonly outcome: 'positive' | 'negative';

  /**
   * Which drive rule(s) were applied, if any.
   * Empty if no rule matched (default affect used).
   */
  readonly appliedRuleIds: string[];

  /** Deltas applied to each drive by this outcome. */
  readonly driveDelta: Partial<Record<DriveName, number>>;

  /**
   * Whether the expression was theatrical (CANON Standard 1).
   * If true, no reinforcement was applied despite the outcome.
   */
  readonly wasTheatrical: boolean;

  /** Guardian feedback source (if any). */
  readonly feedbackSource: 'guardian_confirmation' | 'guardian_correction' | 'algorithmic';
}

/**
 * OPPORTUNITY_CREATED event: A recurring pattern was detected for planning.
 *
 * Emitted when the Drive Engine's pattern detection identifies an opportunity
 * that the Planning subsystem should address.
 */
export interface OpportunityCreatedEvent extends BaseDriveEvent {
  readonly type: 'OPPORTUNITY_CREATED';

  /** UUID of the opportunity. */
  readonly opportunityId: string;

  /**
   * Classification of the opportunity.
   * Determines initial priority in the Planning queue.
   */
  readonly classification:
    | 'PREDICTION_FAILURE_PATTERN'
    | 'HIGH_IMPACT_ONE_OFF'
    | 'BEHAVIORAL_NARROWING'
    | 'GUARDIAN_TEACHING';

  /**
   * Initial priority: HIGH, MEDIUM, or LOW.
   * Decays over time in the Planning queue.
   */
  readonly priority: 'HIGH' | 'MEDIUM' | 'LOW';

  /**
   * Semantic fingerprint of the opportunity context.
   * Used by Planning to group related opportunities.
   */
  readonly contextFingerprint: string;

  /**
   * The primary drive affected by the pattern.
   * Focuses Planning's simulation on relevant effects.
   */
  readonly affectedDrive: DriveName;

  /** Mean absolute error of the prediction(s) that triggered this. */
  readonly predictionMAE: number;
}

/**
 * CONTINGENCY_APPLIED event: A behavioral contingency fired from the rule set.
 *
 * Emitted when the Drive Engine applies a Postgres drive rule to shape behavior.
 * This is distinct from OUTCOME_PROCESSED — contingencies are pre-planned mappings
 * from events to drive effects, while outcomes are empirical results.
 */
export interface ContingencyAppliedEvent extends BaseDriveEvent {
  readonly type: 'CONTINGENCY_APPLIED';

  /** ID of the rule that fired. */
  readonly ruleId: string;

  /** The event type that triggered the rule. */
  readonly eventType: string;

  /** Drives affected by this contingency. */
  readonly driveDelta: Partial<Record<DriveName, number>>;

  /**
   * Confidence [0.0, 1.0] that this contingency is appropriate.
   * Used to weight multiple rules that might apply to the same event.
   */
  readonly confidence: number;
}

/**
 * SELF_EVALUATION_RUN event: The Drive Engine's self-model evaluation cycle.
 *
 * Emitted when the Drive Engine runs self-evaluation (e.g., assessing its own
 * performance on predictions, checking for attractor states, etc.).
 */
export interface SelfEvaluationRunEvent extends BaseDriveEvent {
  readonly type: 'SELF_EVALUATION_RUN';

  /**
   * Type of self-evaluation that was run.
   * E.g., 'PREDICTION_ACCURACY', 'ATTRACTOR_CHECK', 'RULE_DRIFT'
   */
  readonly evaluationType: string;

  /**
   * Summary of the evaluation result.
   * E.g., { predictedAvgMAE: 0.15, observedAvgMAE: 0.18, drifted: true }
   */
  readonly result: Record<string, unknown>;

  /**
   * Whether the evaluation flagged any concerns or anomalies.
   * If true, may trigger rule proposals or Planning opportunities.
   */
  readonly hasConcerns: boolean;
}

/**
 * RULE_APPLIED event: A drive rule from Postgres was matched and applied.
 *
 * Emitted when the Drive Engine matches an event against the Postgres drive_rules
 * table and applies the resulting drive effects. This is the audit trail for
 * rule-based drive modulation.
 */
export interface RuleAppliedEvent extends BaseDriveEvent {
  readonly type: 'RULE_APPLIED';

  /** ID of the matched rule. */
  readonly ruleId: string;

  /** The event type that was looked up. */
  readonly eventType: string;

  /** Drives modified by this rule. */
  readonly driveDelta: Partial<Record<DriveName, number>>;

  /**
   * Whether this rule was part of a guardian-approved set.
   * Used to distinguish system-generated rules from guardian rules.
   */
  readonly isGuardianApproved: boolean;
}

/**
 * HEALTH_STATUS event: Periodic heartbeat and diagnostics.
 *
 * Emitted every N ticks as a keep-alive signal. Includes memory and health
 * metrics used for monitoring the Drive Engine process.
 */
export interface HealthStatusEvent extends BaseDriveEvent {
  readonly type: 'HEALTH_STATUS';

  /** Current tick number. */
  readonly tickNumber: number;

  /** Heap memory used in MB. */
  readonly memoryUsageMb: number;

  /** Whether the process considers itself healthy. */
  readonly healthy: boolean;

  /** Diagnostic message, if any. */
  readonly diagnosticMessage: string | null;
}

/**
 * Union of all Drive Engine event types.
 *
 * Used to ensure type-safe event emission and serialization.
 */
export type DriveEvent =
  | DriveTickEvent
  | OutcomeProcessedEvent
  | OpportunityCreatedEvent
  | ContingencyAppliedEvent
  | SelfEvaluationRunEvent
  | RuleAppliedEvent
  | HealthStatusEvent;
