/**
 * Type definitions for the Supervisor subsystem.
 *
 * The supervisor observes decision cycles and provides corrective
 * training signals via a DeepSeek reasoning model. These types define
 * the narration format (what the supervisor sees), verdict format
 * (what the supervisor produces), and intervention format (what the
 * supervisor or guardian can do).
 */

import type { PressureVector } from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Decision Narration — compact summary sent to the LLM supervisor
// ---------------------------------------------------------------------------

/**
 * A compact summary of one cognitive cycle, built by NarrationBuilderService.
 *
 * Designed to be ~300-500 tokens when serialized — small enough for a single
 * DeepSeek evaluation call. Raw tensor state and full embeddings are excluded.
 */
export interface DecisionNarration {
  cycleId: string;
  timestamp: Date;

  // What happened
  inputSummary: string;
  arbitrationType: 'TYPE_1' | 'TYPE_2' | 'SHRUG';
  actionTaken: string;
  responsePreview: string; // first 200 chars of response text

  // Context
  dominantDrive: string;
  driveSnapshot: PressureVector;

  // Cognition sidecar state (populated when sidecar is running)
  convergenceScore?: number;
  globalModelConfidence?: number;
  panelDivergenceScores?: Record<string, number>;

  // Outcome (may be null if not yet evaluated)
  predictionMAE?: number;
  guardianFeedback?: 'confirmation' | 'correction' | null;
  driveEffectsObserved: Partial<Record<string, number>>;

  /**
   * Behavioral baseline — the recent-history reference frame the supervisor
   * needs to judge "is THIS decision a deviation?" (Evaluation criterion 4:
   * Consistency). Without it, the supervisor can only judge a cycle in
   * isolation and cannot detect drift. Populated by NarrationBuilderService
   * from a rolling window of prior cycles.
   */
  behavioralBaseline?: BehavioralBaseline;
}

/**
 * A compact statistical summary of recent cognitive behavior, used by the
 * supervisor as the reference frame for deviation detection.
 *
 * All figures are derived from a bounded rolling window (no unbounded growth).
 * `sampleCount` lets the supervisor discount the baseline when it is thin
 * (CANON §Development Metrics: a metric on < ~10 samples is unreliable).
 */
export interface BehavioralBaseline {
  /** Number of prior cycles the baseline is computed over. */
  sampleCount: number;

  /** Fraction of recent cycles resolved by each arbitration path. */
  arbitrationMix: { TYPE_1: number; TYPE_2: number; SHRUG: number };

  /** Mean total drive pressure across the recent window. */
  meanTotalPressure: number;

  /** Per-drive mean pressure across the recent window (dominant-drive context). */
  meanDrivePressure: Partial<Record<string, number>>;

  /** Most frequently chosen action names in the recent window (capped). */
  frequentActions: Array<{ action: string; count: number }>;

  /** Mean response latency (ms) across the recent window. */
  meanLatencyMs: number;
}

// ---------------------------------------------------------------------------
// Supervisor Verdict — what the LLM supervisor produces
// ---------------------------------------------------------------------------

export type VerdictRating = 'good' | 'acceptable' | 'questionable' | 'wrong';

export interface SupervisorVerdict {
  cycleId: string;
  timestamp: Date;
  rating: VerdictRating;
  confidence: number; // 0.0-1.0
  reasoning: string;
  reasoningTrace?: string; // DeepSeek reasoning_content (chain of thought)
  /**
   * Model that actually produced this verdict (API-reported). Carried ON the
   * verdict so the audit record reads it from the local result, not a shared
   * mutable instance field — removes the cross-eval race under concurrent evals.
   */
  modelUsed?: string;
  flagForGuardian: boolean;
  flagReason?: string;
  suggestedCorrection?: SupervisorCorrection | null;

  // Cost tracking
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface SupervisorCorrection {
  type: 'reinforce' | 'correct' | 'boost_salience';
  targetAction?: string;
  correctAction?: string;
  reason: string;
}

/**
 * A persisted, auditable record of a single supervisor verdict.
 *
 * CANON §Standard 2 (Provenance Is Sacred): a verdict is an LLM-generated
 * judgement, NOT ground truth. It is persisted with truthful provenance
 * (`LLM_GENERATED`) and the guardian's authority weight is always above the
 * supervisor's, so a verdict never silently becomes "fact". This record is the
 * audit leg — every verdict the supervisor produces is recoverable from
 * TimescaleDB, including the chain-of-thought that produced it.
 */
export interface VerdictAuditRecord {
  verdict: SupervisorVerdict;
  /** Always 'LLM_GENERATED' — a DeepSeek reasoning model produced this. */
  provenance: 'LLM_GENERATED';
  /** Model identifier that produced the verdict (for drift/audit). */
  model: string;
  /** Sampling reason this cycle was evaluated (audit context). */
  evaluationReason: EvaluationReason;
}

/** Why a given cycle was selected for supervisor evaluation. */
export type EvaluationReason =
  | 'burst'
  | 'guardian_feedback'
  | 'attractor_alert'
  | 'sampled';

// ---------------------------------------------------------------------------
// Supervisor Intervention — actions taken by supervisor or guardian
// ---------------------------------------------------------------------------

export type InterventionType =
  | 'reinforce'
  | 'correct'
  | 'freeze_model'
  | 'unfreeze_model'
  | 'rollback_checkpoint'
  | 'boost_salience';

export interface SupervisorIntervention {
  type: InterventionType;
  source: 'supervisor' | 'guardian';
  timestamp: Date;
  cycleId?: string; // which cycle this relates to

  // Type-specific data
  modelName?: string; // for freeze/unfreeze
  checkpointId?: string; // for rollback
  correctionData?: SupervisorCorrection; // for correct
  saliencePattern?: number[]; // for boost_salience

  /**
   * The cycle's global input vector — the exact GLOBAL_INPUT_DIM (1561) feature
   * vector the cognitive cycle was computed from. REQUIRED by the sidecar's
   * /reinforce and /correct endpoints (they Pydantic-reject without it).
   *
   * Plumbed end-to-end: cognition-service assembles it
   * (`_assemble_global_input()`) and surfaces it on its cycle response;
   * decision-making copies it onto `CycleResponse.globalInputVector`; the
   * supervisor threads it here at the verdict→intervention site. It is copied
   * through byte-for-byte (never reconstructed) so it matches what the sidecar's
   * `_split_input_vector()` expects.
   *
   * Still optional: a cycle may genuinely lack an assembled vector (sidecar
   * unavailable / non-tensor path), in which case this stays undefined and
   * reinforce/correct skip honestly for that cycle rather than fabricating one.
   *
   * For boost_salience this is OPTIONAL on the sidecar side, so that path works
   * with or without it.
   */
  inputVector?: number[];
}

// ---------------------------------------------------------------------------
// Intervention Lifecycle — proposed → applied → outcome observed
// ---------------------------------------------------------------------------

/**
 * Lifecycle phase of a supervisor intervention.
 *
 *   proposed       — intervention created (by supervisor verdict or guardian),
 *                    not yet executed against the sidecar.
 *   applied        — sidecar accepted and executed it.
 *   rejected       — sidecar refused it (with an error reason).
 *   outcome_observed — a downstream cycle outcome was attributed back to this
 *                    intervention (closes the audit loop: did it help?).
 */
export type InterventionPhase =
  | 'proposed'
  | 'applied'
  | 'rejected'
  | 'outcome_observed';

/**
 * A single transition in an intervention's lifecycle, with the wall-clock time
 * it occurred. The ordered list of transitions is the auditable trail.
 */
export interface InterventionTransition {
  phase: InterventionPhase;
  at: Date;
  /** Free-form context: rejection error, outcome rating, etc. */
  detail?: string;
}

/**
 * End-to-end record of one intervention across its whole lifecycle.
 *
 * Makes interventions auditable: every intervention can be traced from the
 * moment it was proposed, through application/rejection, to the observed
 * outcome — instead of being a fire-and-forget side effect.
 */
export interface InterventionRecord {
  /** Stable id for cross-referencing transitions and outcomes. */
  interventionId: string;
  intervention: SupervisorIntervention;
  currentPhase: InterventionPhase;
  transitions: InterventionTransition[];
  /** Set once an outcome is attributed. 'positive' | 'negative' | 'neutral'. */
  outcome?: 'positive' | 'negative' | 'neutral';
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Sampling Policy — controls how often the supervisor evaluates
// ---------------------------------------------------------------------------

export interface SamplingPolicy {
  /**
   * Base evaluate-every-Nth-cycle rate (default 10 = 1-in-10).
   *
   * When `adaptive` is true this is the BASELINE rate; the effective rate is
   * derived per-cycle from load / novelty / budget pressure, bounded by
   * [adaptiveMinRate, adaptiveMaxRate]. When `adaptive` is false this is the
   * fixed rate (legacy behavior).
   */
  sampleRate: number;

  /** Always evaluate these event types regardless of sample rate. */
  alwaysEvaluate: ('guardian_feedback' | 'attractor_alert' | 'model_freeze' | 'model_rollback')[];

  /** Burst mode: evaluate every cycle (overrides sampleRate). */
  burstMode: boolean;

  /** Daily budget ceiling in USD. Self-disables when exceeded. */
  dailyBudgetUsd: number;

  /** Enable adaptive (load/novelty/budget-driven) sampling. Default true. */
  adaptive: boolean;

  /** Lower bound on the effective sampling interval (most frequent). */
  adaptiveMinRate: number;

  /** Upper bound on the effective sampling interval (least frequent). */
  adaptiveMaxRate: number;
}

// ---------------------------------------------------------------------------
// Supervisor Status — reported to frontend
// ---------------------------------------------------------------------------

export interface SupervisorStatus {
  enabled: boolean;
  samplingPolicy: SamplingPolicy;
  budgetRemaining: number;
  budgetUsedToday: number;
  totalVerdicts: number;
  recentVerdicts: SupervisorVerdict[];
  flaggedCount: number;

  /** Effective sampling interval currently in force (adaptive output). */
  effectiveSampleRate: number;

  /** Recent intervention lifecycle records (most recent last). */
  recentInterventions: InterventionRecord[];
}
