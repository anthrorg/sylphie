/**
 * Inter-process communication types for the Drive Engine isolation boundary.
 *
 * CANON §Drive Isolation: Drive computation runs in a separate process with
 * one-way communication. The system can READ drive values but cannot WRITE
 * to the evaluation function. This file defines the messages that cross
 * the process boundary in both directions.
 *
 * Inbound (main process → Drive Engine):
 *   ACTION_OUTCOME, SOFTWARE_METRICS, SESSION_START, SESSION_END, SELF_ASSESSMENT
 *
 * Outbound (Drive Engine → main process):
 *   DRIVE_SNAPSHOT, OPPORTUNITY_CREATED, DRIVE_EVENT, HEALTH_STATUS
 *
 * CANON Standard 1 (Theater Prohibition): ActionOutcomePayload includes a
 * theaterCheck field that reports whether the output expression matched the
 * drive state. The directionality is:
 *   - pressure expression: drive must be > 0.2 to be authentic
 *   - relief expression: drive must be < 0.3 to be authentic
 * The Drive Engine uses this to zero-reinforce theatrical outputs.
 *
 * CANON Standard 2 (Contingency Requirement): ActionOutcomePayload carries
 * a required actionId. The Drive Engine rejects payloads without it.
 *
 * CANON Standard 5 (Guardian Asymmetry): feedbackSource is REQUIRED on
 * ActionOutcomePayload. The Drive Engine applies 2x/3x weighting based on
 * whether the feedback source was the guardian or the algorithm.
 */

import type { DriveName } from './drive.types';
import type { DriveSnapshot } from './drive.types';

// ---------------------------------------------------------------------------
// Message Type Enum
// ---------------------------------------------------------------------------

/**
 * All message types that cross the Drive Engine IPC boundary.
 *
 * Using a string enum (rather than a union type) so enum members can be used
 * as switch case labels with exhaustiveness checking.
 *
 * Inbound messages (sent TO the Drive Engine process):
 *   ACTION_OUTCOME:    Report on what happened after an action was executed.
 *   SOFTWARE_METRICS:  Periodic system load data (LLM usage, cognitive effort).
 *   SESSION_START:     A new interaction session has begun.
 *   SESSION_END:       The current session has ended.
 *   SELF_ASSESSMENT:   A KG(Self) self-evaluation snapshot pushed by MAIN. The
 *                      drive caches it and judges it on its own self-eval cadence.
 *                      No actionId, no theater check, no reinforcement — this is
 *                      NOT an outcome and must never ride the contingency path.
 *
 * Outbound messages (sent FROM the Drive Engine process):
 *   DRIVE_SNAPSHOT:       Current drive state after a tick computation.
 *   OPPORTUNITY_CREATED:  Drive Engine detected a pattern worth planning against.
 *   DRIVE_EVENT:          A specific drive event occurred (relief, rule applied, etc.)
 *   THEATER_PROHIBITED:   A theatrical (uncorrelated) expression was detected and
 *                         zero-reinforced (CANON Standard 1 audit trail).
 *   HEALTH_STATUS:        Drive process health check response.
 */
export enum DriveIPCMessageType {
  // Inbound
  ACTION_OUTCOME = 'ACTION_OUTCOME',
  SOFTWARE_METRICS = 'SOFTWARE_METRICS',
  SESSION_START = 'SESSION_START',
  SESSION_END = 'SESSION_END',
  SELF_ASSESSMENT = 'SELF_ASSESSMENT',
  // Outbound
  DRIVE_SNAPSHOT = 'DRIVE_SNAPSHOT',
  OPPORTUNITY_CREATED = 'OPPORTUNITY_CREATED',
  DRIVE_EVENT = 'DRIVE_EVENT',
  THEATER_PROHIBITED = 'THEATER_PROHIBITED',
  HEALTH_STATUS = 'HEALTH_STATUS',
}

// ---------------------------------------------------------------------------
// Generic Message Envelope
// ---------------------------------------------------------------------------

/**
 * The envelope wrapping all IPC messages crossing the Drive Engine boundary.
 *
 * Generic on T to preserve the type of the payload while providing a
 * consistent outer structure for routing and logging.
 *
 * @template T - The specific payload type for this message
 */
export interface DriveIPCMessage<T> {
  /** The message type. Determines how the receiving side routes and handles. */
  readonly type: DriveIPCMessageType;

  /** The message-specific payload. */
  readonly payload: T;

  /** Wall-clock time the message was created (not when it was delivered). */
  readonly timestamp: Date;
}

// ---------------------------------------------------------------------------
// Inbound Payload Types (main process → Drive Engine)
// ---------------------------------------------------------------------------

/**
 * Payload for ACTION_OUTCOME messages.
 *
 * Reports what happened after an action executed. The Drive Engine uses this
 * to apply behavioral contingencies from its Postgres rule set and to evaluate
 * prediction accuracy.
 *
 * actionId is REQUIRED (CANON Standard 2 — Contingency Requirement).
 * feedbackSource is REQUIRED (CANON Standard 5 — Guardian Asymmetry).
 * theaterCheck is REQUIRED (CANON Standard 1 — Theater Prohibition).
 * predictionId is OPTIONAL (E4-T009 — Prediction evaluation).
 */
export interface ActionOutcomePayload {
  /**
   * WKG procedure node ID of the action that was executed.
   * REQUIRED. The Drive Engine cannot apply contingency rules without knowing
   * which specific behavior produced this outcome.
   *
   * CANON Standard 2 (Contingency Requirement): Every reinforcement event
   * must trace to a specific behavior. This field is that trace.
   */
  readonly actionId: string;

  /**
   * OPTIONAL correlation id tying this outcome back to the originating
   * action / inbound event for end-to-end provenance (CANON Standard 2 —
   * Contingency Requirement: every reinforcement event must be auditable to a
   * specific behavior).
   *
   * If the main process already mints a correlation id at the originating
   * event (e.g. the inbound perception/communication event that produced this
   * action), it should be propagated here so the Drive Engine can stamp it onto
   * every drive event it emits in response. If absent, the Drive Engine derives
   * a DETERMINISTIC correlation id from `actionId` at the ingestion boundary
   * (see queueOutcome), so provenance is never lost — only less precise.
   */
  readonly correlationId?: string;

  /**
   * Category of action for diversity tracking and rule matching.
   * Corresponds to the procedure's category field.
   */
  readonly actionType: string;

  /**
   * Whether the action produced the expected outcome.
   * 'positive': Prediction was accurate or outcome was favorable.
   * 'negative': Prediction missed or outcome was unfavorable.
   */
  readonly outcome: 'positive' | 'negative';

  /**
   * Signal metadata for the drive engine to compute effects from.
   *
   * The main process sends WHAT HAPPENED (counts, magnitudes, flags).
   * The drive engine decides WHAT IT MEANS using its internal rule system.
   * No pre-computed drive deltas — the drive engine is fully isolated.
   */
  readonly metadata?: {
    /** Number of undiscovered objects currently in camera view. */
    readonly undiscoveredObjectCount?: number;
    /** Number of unrecognized persons currently in camera view. */
    readonly unknownPersonCount?: number;
    /** Sensory prediction error magnitude [0.0, 1.0]. */
    readonly sensoryPredictionError?: number;
    /** Scene prediction surprise magnitude [0.0, 1.0]. */
    readonly sceneSurprise?: number;
    /** Drive affected by guardian teaching instruction. */
    readonly guardianTeachingDrive?: DriveName;
    /**
     * Hostility magnitude of an inbound message [0.0, 1.0].
     * Carried by InboundHostility action outcomes (TK-86 / DEC-24).
     * Scaled by computeDefaultAffect to apply Anxiety + Social PRESSURE.
     */
    readonly hostilityMagnitude?: number;
  };

  /**
   * Source of the reinforcement feedback signal.
   * REQUIRED. The Drive Engine applies different weights based on source
   * (CANON Standard 5 — Guardian Asymmetry: 2x confirmation, 3x correction).
   *
   * 'guardian_confirmation': Guardian explicitly confirmed this behavior (2x weight).
   * 'guardian_correction':   Guardian explicitly corrected this behavior (3x weight).
   * 'algorithmic':           System-computed evaluation (1x weight, baseline).
   */
  readonly feedbackSource: 'guardian_confirmation' | 'guardian_correction' | 'algorithmic';

  /**
   * Theater Prohibition check data (CANON Standard 1).
   *
   * Reports whether an expression was produced and whether it matched
   * the drive state at the time of output. The Drive Engine uses this to
   * apply zero-reinforcement to theatrical outputs.
   *
   * If no expression was produced, expressionType is 'none' and
   * driveValueAtExpression should be set to the relevant drive value.
   */
  readonly theaterCheck: {
    /**
     * Whether this action produced an expression:
     * 'pressure': Expressing distress/need/urgency (must have drive > 0.2 to be authentic).
     * 'relief':   Expressing contentment/calm/fulfillment (must have drive < 0.3 to be authentic).
     * 'none':     No emotional expression was produced.
     */
    readonly expressionType: 'pressure' | 'relief' | 'none';

    /**
     * The relevant drive value at the time of expression.
     * For pressure expressions: the drive that was expressed.
     * For relief expressions: the drive whose satisfaction was claimed.
     * For 'none': the dominant drive at the time of action.
     * Value in [-10.0, 1.0] per CANON drive range.
     */
    readonly driveValueAtExpression: number;

    /**
     * Name of the drive involved in the expression check.
     * Used by the Drive Engine to look up the current value for comparison.
     */
    readonly drive: DriveName;

    /**
     * Whether the Theater Prohibition validator flagged this as theatrical.
     * If true, the Drive Engine applies zero-reinforcement regardless of
     * guardian response (Standard 1).
     */
    readonly isTheatrical: boolean;
  };

  /**
   * Anxiety level at the time the action was dispatched.
   * Required for CANON §A.15 Anxiety Amplification:
   * If anxiety > 0.7 AND outcome is 'negative', the Drive Engine applies 1.5x
   * confidence reduction to the action's WKG procedure node.
   */
  readonly anxietyAtExecution: number;

  /**
   * Optional prediction ID for accuracy evaluation (E4-T009).
   * When present, includes prediction outcome data for MAE computation.
   * If absent, the outcome is not evaluated as a prediction.
   */
  readonly predictionData?: {
    /** The unique ID of the prediction being evaluated. */
    readonly predictionId: string;
    /** Predicted outcome value [0.0, 1.0]. */
    readonly predictedValue: number;
    /** Actual outcome value [0.0, 1.0]. */
    readonly actualValue: number;
  };

  /**
   * Optional information gain metrics for Curiosity Information Gain contingency.
   *
   * CANON §A.14 Behavioral Contingency — Curiosity Information Gain:
   * Curiosity relief is proportional to actual new information gained.
   * The main backend populates these fields from WKG operations that
   * occurred during action execution.
   *
   * If absent, the curiosity contingency degrades gracefully (returns 0).
   *
   * CANON §A.14 + Standard 2 honesty gate: curiosity relief is earned ONLY from
   * a real, action-attributed WKG diff. The `source` field carries that
   * provenance. The Drive Engine grants relief only when source === 'WKG_DIFF'
   * (an atlas-computed before/after diff attributed to THIS action). Any other
   * value ('UNVERIFIED' or omitted metrics) yields zero relief — the system
   * must never defraud curiosity with guessed numbers.
   */
  readonly informationGainMetrics?: {
    /** Number of new WKG nodes created during this action's execution. */
    readonly newNodes: number;
    /** Sum of positive confidence increases for existing WKG nodes. */
    readonly confidenceDeltas: number;
    /** Number of prediction errors that were resolved by the outcome. */
    readonly resolvedErrors: number;
    /**
     * Provenance of these metrics.
     * 'WKG_DIFF':   atlas computed a real before/after WKG diff attributed to
     *               this action only. Earns proportional curiosity relief.
     * 'UNVERIFIED': metrics could not be attributed to this action
     *               (concurrency, no snapshot). Drive grants zero relief.
     */
    readonly source: 'WKG_DIFF' | 'UNVERIFIED';
  };

  /**
   * Optional timestamp of when a social comment was initiated.
   *
   * CANON §A.14 Behavioral Contingency — Social Comment Quality:
   * When the action was a Sylphie-initiated social comment, this records
   * the wall-clock timestamp of initiation. Used to evaluate whether
   * the guardian responded within the 30-second bonus window.
   *
   * If absent, the social comment quality contingency does not fire
   * during applyContingencies(). The standalone processGuardianResponse()
   * path remains available as an additional trigger.
   */
  readonly socialCommentTimestamp?: number;
}

/**
 * Payload for SOFTWARE_METRICS messages.
 *
 * Periodic system telemetry sent from the main process to the Drive Engine.
 * The Drive Engine uses LLM usage data to apply cognitive effort drive pressure
 * (CANON §Dual-Process: Type 2 must always carry an explicit cost).
 *
 * CANON Gap 4: cognitiveEffortPressure is the critical field that creates
 * evolutionary pressure toward Type 1 graduation. Without it, Type 2 has
 * no cost and Type 1 never develops.
 */
export interface SoftwareMetricsPayload {
  /** Number of LLM API calls made since last metrics report. */
  readonly llmCallCount: number;

  /** Total LLM latency in milliseconds since last metrics report. */
  readonly llmLatencyMs: number;

  /**
   * Computed cognitive effort pressure to apply to the CognitiveAwareness drive.
   * Derived from llmCallCount, llmLatencyMs, and token usage. The exact formula
   * is owned by the Drive Engine's metrics handler — this is the pre-computed
   * input value in [0.0, 1.0].
   *
   * This field creates the behavioral pressure that drives Type 1 graduation.
   * CANON: "Without cost, the LLM always wins and Type 1 never develops."
   */
  readonly cognitiveEffortPressure: number;

  /** Total LLM tokens used since last metrics report (prompt + completion). */
  readonly tokenCount: number;

  /**
   * Estimated USD cost of LLM API calls since last metrics report.
   * Used for monitoring and potential future budget-based rate limiting.
   */
  readonly estimatedCostUsd: number;

  /** Wall-clock window start for this metrics batch. */
  readonly windowStartAt: Date;

  /** Wall-clock window end for this metrics batch. */
  readonly windowEndAt: Date;
}

/**
 * Payload for SESSION_START messages.
 * Notifies the Drive Engine a new interaction session has begun.
 */
export interface SessionStartPayload {
  /** The new session ID. Correlated with DriveSnapshot.sessionId going forward. */
  readonly sessionId: string;

  /**
   * Drive state at session start (from the previous session's final snapshot,
   * or INITIAL_DRIVE_STATE for cold start).
   */
  readonly initialDriveState: DriveSnapshot;
}

/**
 * Payload for SESSION_END messages.
 * Notifies the Drive Engine the session is ending and requests a final snapshot.
 */
export interface SessionEndPayload {
  /** The ending session ID. */
  readonly sessionId: string;

  /** Duration of the session in milliseconds. */
  readonly durationMs: number;
}

/**
 * Provenance of a self-assessment snapshot.
 *
 * CANON Standard 3 (Confidence Ceiling) + Standard 6 (No Self-Modification of
 * Evaluation): an inferred self-assessment ("I'm bad at X") must NOT be trusted
 * like a guardian-confirmed fact. The Drive Engine uses provenance to (a) clamp
 * capability confidence to the ≤0.60 ceiling unless GUARDIAN, and (b) suppress
 * baseline reduction from inferred/bootstrap assessments to avoid driving the
 * Depressive Attractor from unverified self-judgement.
 *
 * 'GUARDIAN':                    Guardian-confirmed assessment (full trust).
 * 'GUARDIAN_APPROVED_INFERENCE': System inference the guardian reviewed/approved.
 * 'INFERENCE':                   System-inferred from experience (unverified).
 * 'SYSTEM_BOOTSTRAP':            Cold-start default assessment (unverified).
 */
export type SelfAssessmentProvenance =
  | 'GUARDIAN'
  | 'GUARDIAN_APPROVED_INFERENCE'
  | 'INFERENCE'
  | 'SYSTEM_BOOTSTRAP';

/**
 * Payload for SELF_ASSESSMENT messages.
 *
 * A KG(Self) self-evaluation snapshot computed by MAIN (apps/sylphie + atlas)
 * and pushed to the Drive Engine. The drive caches the latest snapshot on
 * receipt and consumes it on its own self-evaluation cadence (every 10 ticks).
 *
 * CANON §E4-T008 (KG(Self) self-evaluation on slower timescale) + §Drive
 * Isolation: this is the event-judge model. MAIN computes from Grafeo/KG(Self)
 * and PUSHES; the Drive Engine never pulls/queries MAIN. Before the first push
 * arrives the drive degrades to today's safe neutral (no assessment data → no
 * baseline adjustment). MAIN must never fabricate: an empty KG(Self) yields
 * empty arrays here, not invented capabilities.
 *
 * This is NOT an ActionOutcome: it has no actionId, no theaterCheck, no
 * feedbackSource, and produces NO reinforcement. Routing it through the
 * contingency path would violate CANON Standard 2 (Contingency Requirement).
 */
export interface SelfAssessmentPayload {
  /** Wall-clock time MAIN computed this assessment snapshot. */
  readonly assessedAt: Date;

  /**
   * Self-assessed capabilities. `name` MUST match a key in the Drive Engine's
   * CAPABILITY_TO_DRIVE_MAP to influence a drive baseline:
   *   social_interaction, knowledge_retrieval, prediction_accuracy, error_correction.
   * Unknown names are ignored by the reader.
   */
  readonly capabilities: ReadonlyArray<{
    /** Unique identifier for this capability node in KG(Self). */
    readonly id: string;
    /** Capability name (see CAPABILITY_TO_DRIVE_MAP keys). */
    readonly name: string;
    /** Success rate over recent uses [0.0, 1.0]. */
    readonly successRate: number;
    /** Confidence in this success-rate estimate [0.0, 1.0]. */
    readonly confidence: number;
    /** Number of samples used to compute successRate. */
    readonly sampleCount: number;
    /** Wall-clock time this capability was last executed. */
    readonly lastExecuted: Date;
  }>;

  /**
   * Observed drive patterns (informational; not used for baseline reduction).
   */
  readonly drivePatterns: ReadonlyArray<{
    /** The drive involved in the pattern. */
    readonly drive: DriveName;
    /** Human-readable stimulus description. */
    readonly stimulus: string;
    /** Typical response strength [0.0, 1.0]. */
    readonly responseStrength: number;
    /** Example observations of this pattern. */
    readonly examples: ReadonlyArray<string>;
    /** Wall-clock time of the most recent observation. */
    readonly lastObserved: Date;
    /** Confidence in this pattern [0.0, 1.0]. */
    readonly confidence: number;
  }>;

  /**
   * Prediction accuracy per domain (informational; used for Integrity context).
   */
  readonly predictionAccuracy: ReadonlyArray<{
    /** Domain name (e.g., "user_behavior", "action_outcomes"). */
    readonly domain: string;
    /** Mean Absolute Error of predictions in this domain. */
    readonly mae: number;
    /** Number of predictions analyzed. */
    readonly sampleCount: number;
    /** Confidence in this MAE estimate [0.0, 1.0]. */
    readonly confidence: number;
    /** Wall-clock time of the last prediction in this domain. */
    readonly lastUpdated: Date;
  }>;

  /**
   * Provenance of this assessment. Gates trust (CANON Standard 3 ceiling) and
   * whether baseline reduction is permitted (Depressive Attractor guard).
   */
  readonly provenance: SelfAssessmentProvenance;
}

// ---------------------------------------------------------------------------
// Outbound Payload Types (Drive Engine → main process)
// ---------------------------------------------------------------------------

/**
 * Payload for DRIVE_SNAPSHOT messages.
 * The Drive Engine publishes this after every tick computation.
 * Wraps DriveSnapshot directly — no additional fields needed.
 */
export interface DriveSnapshotPayload {
  /** The full drive snapshot from this tick. */
  readonly snapshot: DriveSnapshot;
}

/**
 * Priority classification for opportunities.
 *
 * HIGH:   Recurring pattern with high drive impact — plan immediately.
 * MEDIUM: Moderate impact pattern or one-off high-impact event.
 * LOW:    Low-impact non-recurring pattern — potential opportunity only.
 */
export type OpportunityPriority = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Opportunity classification by origin type.
 *
 * PREDICTION_FAILURE_PATTERN: Recurring prediction failures indicate a gap in Sylphie's model.
 * HIGH_IMPACT_ONE_OFF:        A single high-drive-impact event worth planning around.
 * BEHAVIORAL_NARROWING:       Diversity index declining — new action types needed.
 * GUARDIAN_TEACHING:          Guardian initiated a teaching sequence.
 */
export type OpportunityClassification =
  | 'PREDICTION_FAILURE_PATTERN'
  | 'HIGH_IMPACT_ONE_OFF'
  | 'BEHAVIORAL_NARROWING'
  | 'GUARDIAN_TEACHING';

/**
 * Payload for OPPORTUNITY_CREATED messages.
 *
 * Sent by the Drive Engine when it detects a pattern worth addressing through
 * the Planning subsystem. The Planning module receives this and adds it to
 * the opportunity priority queue.
 *
 * CANON §Subsystem 5 (Planning): Triggered by Opportunities detected by Drive Engine.
 * CANON §Known Attractor States: Opportunity queue must have decay to prevent runaway.
 */
export interface OpportunityCreatedPayload {
  /** UUID v4. Unique identifier for this opportunity. */
  readonly id: string;

  /**
   * Semantic fingerprint of the context in which this opportunity was detected.
   * Used by Planning to group related opportunities and avoid duplicate plans.
   */
  readonly contextFingerprint: string;

  /** How this opportunity was classified by the Drive Engine. */
  readonly classification: OpportunityClassification;

  /**
   * Initial priority of this opportunity.
   * Decays over time in the Planning queue (CANON: "Opportunity priority queue with decay").
   */
  readonly priority: OpportunityPriority;

  /** The TimescaleDB event ID that triggered opportunity detection. */
  readonly sourceEventId: string;

  /**
   * The drive most affected by the pattern that triggered this opportunity.
   * Planning uses this to focus simulation on relevant drive effects.
   */
  readonly affectedDrive: DriveName;

  /**
   * Guardian's original instruction text when classification is GUARDIAN_TEACHING.
   * Absent for Drive Engine-detected opportunities. Present when the guardian
   * explicitly requested planning through conversation.
   */
  readonly guardianInstruction?: string;
}

/**
 * Payload for DRIVE_EVENT messages.
 *
 * Published by the Drive Engine when a specific drive event occurs that
 * subsystems should be aware of (not just routine ticks). Examples:
 * drive relief after a successful action, rule applied, threshold crossed.
 */
export interface DriveEventPayload {
  /**
   * The specific event type within the Drive Engine.
   * Maps to the EventType values owned by DRIVE_ENGINE in the boundary map.
   */
  readonly driveEventType: 'DRIVE_RELIEF' | 'DRIVE_RULE_APPLIED' | 'OPPORTUNITY_DETECTED' | 'SELF_EVALUATION_RUN';

  /**
   * The drive affected by this event.
   */
  readonly drive: DriveName;

  /**
   * The magnitude of the drive change.
   * Negative = relief (drive pressure decreased). Positive = pressure increased.
   */
  readonly delta: number;

  /**
   * ID of the Postgres rule that was applied, if any.
   * Null if this was a default affect or system-computed event.
   */
  readonly ruleId: string | null;

  /**
   * Correlation id tying this drive event back to the originating action /
   * inbound event (CANON Standard 2 — provenance is auditable end-to-end).
   *
   * Propagated from the triggering ActionOutcomePayload.correlationId (or the
   * deterministic id derived from its actionId). Null for drive events that do
   * not originate from a specific inbound action (e.g. routine tick-driven
   * events), which keeps the contingency trace honest rather than fabricated.
   */
  readonly correlationId: string | null;

  /** The current snapshot after this event was applied. */
  readonly snapshot: DriveSnapshot;
}

/**
 * Payload for THEATER_PROHIBITED messages (CANON Standard 1 — Theater Prohibition).
 *
 * Emitted by the Drive Engine when an action's emotional expression did NOT
 * correlate with the actual drive state (a directional threshold breach) and was
 * therefore zero-reinforced. This carries the full forensic record to the parent,
 * which drains it to the TimescaleDB event backbone as the durable audit trail.
 *
 * CANON §Drive Isolation: the Drive Engine is a separate process and does NOT
 * write TimescaleDB directly — it emits this over IPC and the parent persists it,
 * mirroring DRIVE_EVENT / OPPORTUNITY_CREATED.
 *
 * CANON Standard 1 GUARDRAIL: this is an AUDIT/EVENT-TRAIL record ONLY. It must
 * NEVER feed any positive reinforcement contingency. The reinforcement decision
 * (zero reinforcement) has already been made at the point this is emitted; this
 * payload exists solely to make the prohibition observable and reviewable.
 */
export interface TheaterProhibitedPayload {
  /**
   * WKG procedure node ID of the offending action (CANON Standard 2 trace).
   * The specific behavior whose expression was theatrical.
   */
  readonly actionId: string;

  /**
   * Correlation id tying this prohibition back to the originating action /
   * inbound event (CANON Standard 2 — auditable provenance). Propagated from
   * the triggering ActionOutcomePayload.correlationId (or the deterministic id
   * derived from its actionId). Null only if no correlation could be resolved.
   */
  readonly correlationId: string | null;

  /** Category of the offending action (procedure's category field). */
  readonly actionType: string;

  /**
   * The offending expression: what the action CLAIMED to express.
   * 'pressure' (distress/need/urgency) or 'relief' (contentment/calm/fulfillment).
   * ('none' never reaches this payload — a non-expression cannot be theatrical.)
   */
  readonly offendingExpressionType: 'pressure' | 'relief';

  /** The drive whose state was checked against the claimed expression. */
  readonly drive: DriveName;

  /**
   * Expected-vs-actual: the directional threshold the expression needed to clear
   * to be authentic, and the drive value actually observed.
   *   - pressure: authentic iff actualDriveValue > expectedThreshold (0.2)
   *   - relief:   authentic iff actualDriveValue < expectedThreshold (0.3)
   */
  readonly expectedThreshold: number;

  /** The actual drive value at the time of the expression check. */
  readonly actualDriveValue: number;

  /**
   * Human-readable verdict reason from the Theater Prohibition validator
   * (e.g. "Pressure expression (anxiety) requires drive > 0.2, but was 0.05").
   */
  readonly verdictReason: string;

  /** The drive snapshot at the time the prohibition was detected. */
  readonly snapshot: DriveSnapshot;
}

/**
 * Payload for HEALTH_STATUS messages.
 *
 * Sent by the Drive Engine in response to health check requests, and
 * periodically as a keep-alive signal. The IDriveProcessManager uses this
 * to detect stalled or crashed Drive Engine processes.
 */
export interface HealthStatusPayload {
  /** Whether the Drive Engine is functioning normally. */
  readonly healthy: boolean;

  /** Current tick number. Used to detect stalled ticks. */
  readonly currentTick: number;

  /** Milliseconds since the last successful tick. */
  readonly msSinceLastTick: number;

  /**
   * Any diagnostic message when healthy is false.
   * Null when healthy is true.
   */
  readonly diagnosticMessage: string | null;
}
