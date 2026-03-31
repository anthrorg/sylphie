/**
 * Drive Engine module interface contracts.
 *
 * CANON §Drive Isolation: Drive computation runs in a separate process with
 * one-way communication. The system can READ drive values but cannot WRITE
 * to the evaluation function.
 *
 * CANON Immutable Standard 6 (No Self-Modification of Evaluation):
 * IDriveStateReader exposes ZERO write methods. Drive state flows outward
 * from the Drive Engine process. Nothing outside the process modifies drive
 * values or the evaluation function.
 *
 * CANON Immutable Standard 1 (Theater Prohibition): ActionOutcomeReporter
 * carries the theaterCheck payload so the Drive Engine can apply
 * zero-reinforcement to theatrical outputs.
 *
 * CANON Immutable Standard 2 (Contingency Requirement): reportOutcome
 * requires actionId — the Drive Engine cannot apply contingency rules
 * without knowing which specific behavior produced this outcome.
 */

import { Observable } from 'rxjs';
import { DriveSnapshot, DriveName } from '../../shared/types/drive.types';
import { ProvenanceSource } from '../../shared/types/provenance.types';

// ---------------------------------------------------------------------------
// Opportunity types (local to this module)
// ---------------------------------------------------------------------------

/**
 * Classification of an opportunity detected by the Drive Engine.
 *
 * RECURRING_FAILURE:  A prediction failure pattern has repeated enough times
 *                     to warrant structured intervention by the Planning subsystem.
 * HIGH_IMPACT_FAILURE: A single prediction failure with an unusually large
 *                      drive delta — worth planning around even in isolation.
 * POTENTIAL:           A pattern that has not yet crossed the recurrence or
 *                      impact threshold, but is being tracked.
 */
export type OpportunityClassification =
  | 'RECURRING_FAILURE'
  | 'HIGH_IMPACT_FAILURE'
  | 'POTENTIAL';

/**
 * An opportunity surfaced by the Drive Engine for the Planning subsystem.
 *
 * The Drive Engine creates opportunities when it detects prediction failure
 * patterns that the Planning subsystem should address by researching and
 * proposing new action procedures.
 *
 * CANON §Subsystem 5 (Planning): triggered by Opportunities detected by the
 * Drive Engine. CANON §Known Attractor States: the opportunity queue must
 * have decay to prevent Planning Runaway.
 */
export interface Opportunity {
  /** UUID v4. Unique identifier for this opportunity. */
  readonly id: string;

  /**
   * Semantic fingerprint of the context in which this opportunity was
   * detected. Used by Planning to group related opportunities and avoid
   * duplicate plans.
   */
  readonly contextFingerprint: string;

  /** How the Drive Engine classified this opportunity. */
  readonly classification: OpportunityClassification;

  /**
   * Priority score in [0.0, 1.0]. Higher values are addressed first by
   * the Planning subsystem. Decays over time in the Planning queue to
   * prevent stale opportunities from blocking newer ones.
   */
  readonly priority: number;

  /** TimescaleDB event ID that triggered opportunity detection. */
  readonly sourceEventId: string;

  /**
   * Mean absolute error of the prediction(s) that produced this opportunity.
   * Drives both classification and initial priority assignment.
   */
  readonly predictionMAE: number;

  /** Wall-clock time this opportunity was created by the Drive Engine. */
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Proposed drive rule
// ---------------------------------------------------------------------------

/**
 * A proposed modification to the Postgres drive rule set, submitted for
 * guardian review before activation.
 *
 * CANON Immutable Standard 6 (No Self-Modification of Evaluation): The system
 * may only INSERT into proposed_drive_rules. It cannot modify active rules.
 * Only guardian-approved changes reach the active rule set.
 */
export interface ProposedDriveRule {
  /**
   * The EventType string this rule matches against.
   * Must be a valid member of the EventType union in event.types.ts.
   */
  readonly eventType: string;

  /**
   * Drive deltas applied when this rule matches.
   * Partial map — only drives with non-zero effects need be included.
   * Values are deltas (positive = pressure increase, negative = relief).
   */
  readonly driveEffects: Partial<Record<DriveName, number>>;

  /**
   * Human-readable condition description explaining when this rule fires.
   * Example: "When a social comment receives a guardian response within 30s"
   */
  readonly condition: string;

  /**
   * Explanation of why this rule change is being proposed.
   * Required to give the guardian enough context to approve or reject.
   */
  readonly rationale: string;

  /**
   * Who initiated this proposal.
   * SYSTEM:   Proposed autonomously by the Drive Engine pattern detection.
   * GUARDIAN: Guardian requested this rule via the dashboard.
   */
  readonly proposedBy: 'SYSTEM' | 'GUARDIAN';
}

// ---------------------------------------------------------------------------
// Software metrics (Type 2 cost tracking)
// ---------------------------------------------------------------------------

/**
 * Software usage metrics for Type 2 cognitive effort cost reporting.
 *
 * CANON §Dual-Process Cognition: Type 2 must always carry explicit cost.
 * Without it, the LLM always wins and Type 1 never develops. These metrics
 * are the mechanism that creates evolutionary pressure toward Type 1 graduation.
 *
 * This is the local module type. The IPC serialization form is
 * SoftwareMetricsPayload in ipc.types.ts. They carry the same essential
 * fields; the IPC payload adds window timestamps.
 */
export interface SoftwareMetrics {
  /** Number of LLM API calls in this reporting window. */
  readonly llmCallCount: number;

  /** Total LLM latency in milliseconds in this reporting window. */
  readonly llmLatencyMs: number;

  /** Total tokens (prompt + completion) consumed in this reporting window. */
  readonly tokenCount: number;

  /**
   * Pre-computed cognitive effort pressure to apply to CognitiveAwareness.
   * Value in [0.0, 1.0]. Derived from llmCallCount, llmLatencyMs, and
   * tokenCount by the caller before sending.
   *
   * This field is load-bearing: it is what creates the drive pressure that
   * makes Type 1 graduation behaviorally desirable (CANON Gap 4).
   */
  readonly cognitiveEffortPressure: number;
}

// ---------------------------------------------------------------------------
// IDriveStateReader — ZERO write methods (CANON Standard 6)
// ---------------------------------------------------------------------------

/**
 * Read-only facade for drive state access, exposed to all subsystem modules.
 *
 * CANON Immutable Standard 6 (No Self-Modification of Evaluation):
 * This interface has ZERO write methods. Subsystems may read the current
 * drive state and subscribe to changes, but they cannot influence the Drive
 * Engine's computation or evaluation function through this interface.
 *
 * The values returned may be 1–2 ticks stale due to the IPC hop from the
 * child process, but this is acceptable — drive values change slowly relative
 * to the tick interval (100Hz target).
 *
 * Injection token: DRIVE_STATE_READER (drive-engine.tokens.ts)
 * Provided by:    DriveReaderService
 */
export interface IDriveStateReader {
  /**
   * Returns the most recent drive snapshot received from the Drive Engine
   * process. May be 1–2 ticks stale due to IPC latency.
   *
   * For cold start before the first IPC message arrives, returns a snapshot
   * built from INITIAL_DRIVE_STATE (CANON §A.14).
   *
   * @returns The latest DriveSnapshot — never null, never throws.
   */
  getCurrentState(): DriveSnapshot;

  /**
   * Hot observable of drive snapshots. Emits a new DriveSnapshot every time
   * the Drive Engine process completes a tick (target: 100Hz).
   *
   * Subscribers should apply appropriate sampling (e.g., auditTime, debounceTime)
   * if they do not need full 100Hz resolution — most subsystems only need
   * to react to meaningful changes, not every tick.
   *
   * READ-ONLY. Subscribing does not affect the Drive Engine process.
   */
  readonly driveState$: Observable<DriveSnapshot>;

  /**
   * Returns the sum of all positive drive values from the current snapshot's
   * pressureVector. Drives at or below zero contribute nothing (they are in
   * the extended relief range and represent no unmet need).
   *
   * Result is in [0.0, 12.0] (12 drives, each capped at 1.0).
   * Equivalent to getCurrentState().totalPressure but provided as a named
   * method for clarity at call sites.
   *
   * @returns Total unmet pressure across all 12 drives.
   */
  getTotalPressure(): number;
}

// ---------------------------------------------------------------------------
// IActionOutcomeReporter — fire-and-forget IPC write channel
// ---------------------------------------------------------------------------

/**
 * One-way channel for reporting action outcomes to the Drive Engine process.
 *
 * All methods are fire-and-forget (void return). The caller sends the data
 * and does not wait for acknowledgment. The Drive Engine process applies
 * the outcome on the next tick.
 *
 * This is NOT a write path to the evaluation function — it sends INPUT data
 * to an isolated process. The process's rules and evaluation logic cannot
 * be modified through this interface (CANON Standard 6).
 *
 * Injection token: ACTION_OUTCOME_REPORTER (drive-engine.tokens.ts)
 * Provided by:    ActionOutcomeReporterService
 */
export interface IActionOutcomeReporter {
  /**
   * Report an action outcome for drive evaluation.
   *
   * The Drive Engine process receives this via IPC and applies the relevant
   * Postgres drive rules (contingency evaluation). Missing or invalid
   * actionId means the Drive Engine cannot attribute reinforcement to a
   * specific behavior, violating CANON Standard 2.
   *
   * theaterCheck is required — if the expression was theatrical (Standard 1),
   * the Drive Engine applies zero-reinforcement regardless of outcome.
   *
   * @param outcome - The outcome payload. See field docs for CANON obligations.
   */
  reportOutcome(outcome: {
    /**
     * WKG procedure node ID of the executed action.
     * REQUIRED. CANON Standard 2 (Contingency Requirement).
     */
    readonly actionId: string;

    /** Category string of the action (for diversity tracking). */
    readonly actionType: string;

    /**
     * Whether the action produced the expected or favorable outcome.
     * Maps to 'positive' | 'negative' on the IPC payload.
     */
    readonly success: boolean;

    /**
     * Observed drive deltas from this action.
     * Partial map — only drives that changed are included.
     */
    readonly driveEffects: Partial<Record<DriveName, number>>;

    /**
     * Source of the feedback signal.
     * CANON Standard 5 (Guardian Asymmetry): GUARDIAN sources receive 2x
     * confirmation weight or 3x correction weight in Drive Engine evaluation.
     * Use full ProvenanceSource — the Drive Engine maps GUARDIAN to the
     * appropriate weight by context.
     */
    readonly feedbackSource: ProvenanceSource;

    /**
     * Theater Prohibition check data (CANON Standard 1).
     *
     * expressionType: The kind of emotional expression this action produced,
     *   or 'none' if no expression was produced.
     * correspondingDrive: The drive whose state was expressed, or null if none.
     * driveValue: The drive's value at the time of expression, or null if none.
     * isTheatrical: True if the Theater validator flagged a mismatch between
     *   expression and drive state. If true, Drive Engine applies
     *   zero-reinforcement regardless of guardian response.
     */
    readonly theaterCheck: {
      readonly expressionType: 'pressure' | 'relief' | 'none';
      readonly correspondingDrive: DriveName | null;
      readonly driveValue: number | null;
      readonly isTheatrical: boolean;
    };

    /**
     * Optional prediction ID to associate with this outcome.
     * When provided, the Drive Engine links this outcome to the prediction
     * for MAE accumulation and Type 1/2 graduation tracking.
     */
    readonly predictionId?: string;
  }): void;

  /**
   * Report software usage metrics to the Drive Engine for Type 2 cost pressure.
   *
   * CANON §Dual-Process Cognition: This call is what creates the cognitive
   * effort drive pressure that incentivizes Type 1 graduation over time.
   * Omitting this call suppresses the cost signal and allows Type 2 addiction
   * (CANON §Known Attractor States: "Type 2 Addict").
   *
   * @param metrics - LLM usage data. cognitiveEffortPressure is load-bearing.
   */
  reportMetrics(metrics: SoftwareMetrics): void;
}

// ---------------------------------------------------------------------------
// IRuleProposer — guardian-gated rule proposal
// ---------------------------------------------------------------------------

/**
 * Interface for proposing new drive rules for guardian review.
 *
 * CANON Immutable Standard 6 (No Self-Modification of Evaluation):
 * The system can only INSERT into proposed_drive_rules via this interface.
 * Active rules in the Postgres drive_rules table are write-protected from
 * autonomous modification. Only guardian-approved proposals reach the active set.
 *
 * Injection token: RULE_PROPOSER (drive-engine.tokens.ts)
 * Provided by:    RuleProposerService
 */
export interface IRuleProposer {
  /**
   * Submit a new drive rule for guardian review.
   *
   * Inserts a row into the proposed_drive_rules Postgres table. The guardian
   * reviews proposals via the dashboard and approves or rejects them. Approved
   * proposals are copied to the active drive_rules table by the guardian tooling —
   * never autonomously by the system.
   *
   * @param rule - The proposed rule. proposedBy field distinguishes system
   *               proposals from guardian-initiated ones.
   * @throws {DriveEngineException} If the database write fails.
   */
  proposeRule(rule: ProposedDriveRule): Promise<void>;
}

// ---------------------------------------------------------------------------
// IDriveProcessManager — internal lifecycle management
// ---------------------------------------------------------------------------

/**
 * Lifecycle management for the Drive Engine child process.
 *
 * THIS INTERFACE IS INTERNAL TO DriveEngineModule. It is NOT exported from
 * the module barrel (index.ts). No other module should ever depend on process
 * management — they read drive state via IDriveStateReader.
 *
 * Implemented by DriveProcessManagerService, which manages the isolated
 * child_process that runs the drive computation loop. One-way communication
 * boundary: inbound IPC messages arrive as DriveSnapshot events; outbound
 * messages are action outcomes and metrics (never rule modifications).
 *
 * Injection token: DRIVE_PROCESS_MANAGER (drive-engine.tokens.ts)
 * Scope: INTERNAL to DriveEngineModule only.
 */
export interface IDriveProcessManager {
  /**
   * Start the drive computation child process.
   *
   * Spawns the child process, establishes the IPC channel, and begins
   * forwarding DRIVE_SNAPSHOT messages to DriveReaderService. Should be
   * called from DriveEngineModule's OnModuleInit hook.
   *
   * @throws {DriveEngineException} If the process fails to start or the
   *         initial health check does not respond within the timeout.
   */
  start(): Promise<void>;

  /**
   * Stop the drive computation child process gracefully.
   *
   * Sends a shutdown signal to the child process and waits for clean exit.
   * Called from DriveEngineModule's OnModuleDestroy hook. If the process
   * does not exit within the graceful timeout, it is force-killed.
   */
  stop(): Promise<void>;

  /**
   * Check whether the child process is healthy and responsive.
   *
   * A process is healthy if it has been running, has responded to a health
   * check within the last heartbeat window, and its last tick was recent.
   * Returns false if the process has not been started or has crashed.
   *
   * @returns True if the process is running and responsive.
   */
  isHealthy(): boolean;
}
