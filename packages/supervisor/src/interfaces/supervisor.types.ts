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
}

// ---------------------------------------------------------------------------
// Sampling Policy — controls how often the supervisor evaluates
// ---------------------------------------------------------------------------

export interface SamplingPolicy {
  /** Evaluate every Nth cycle (default 10 = 1-in-10). */
  sampleRate: number;

  /** Always evaluate these event types regardless of sample rate. */
  alwaysEvaluate: ('guardian_feedback' | 'attractor_alert' | 'model_freeze' | 'model_rollback')[];

  /** Burst mode: evaluate every cycle (overrides sampleRate). */
  burstMode: boolean;

  /** Daily budget ceiling in USD. Self-disables when exceeded. */
  dailyBudgetUsd: number;
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
}
