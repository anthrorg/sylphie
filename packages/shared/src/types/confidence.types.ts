/**
 * Confidence dynamics types and computation functions.
 *
 * CANON §Confidence Dynamics: All confidence values are in [0.0, 1.0].
 * The ACT-R formula governs how confidence grows through use and decays
 * through disuse. This is a pure computational layer — no I/O, no side
 * effects, no external dependencies beyond provenance types.
 *
 * CANON Immutable Standard 6 (No Self-Modification of Evaluation): The
 * computeConfidence() function is write-protected from system-initiated
 * modification. It is pure and must remain so.
 */

import type { CoreProvenanceSource } from './provenance.types';

// ---------------------------------------------------------------------------
// ACT-R Parameters
// ---------------------------------------------------------------------------

/**
 * Per-node/per-edge parameters for the ACT-R confidence formula.
 * Stored alongside every WKG node and edge and updated on each retrieval.
 */
export interface ACTRParams {
  /** Initial confidence at creation, derived from provenance (CANON §Confidence Dynamics). */
  readonly base: number;

  /** Number of successful retrieval-and-use events. Drives logarithmic growth. */
  readonly count: number;

  /**
   * Temporal decay rate (d in the formula). Per-type; slower for GUARDIAN
   * knowledge, faster for LLM_GENERATED. See DEFAULT_DECAY_RATES.
   */
  readonly decayRate: number;

  /**
   * Timestamp of the most recent successful retrieval. Null if the node/edge
   * has never been retrieved (count === 0 implies this is null).
   */
  readonly lastRetrievalAt: Date | null;
}

// ---------------------------------------------------------------------------
// Thresholds (CANON §Confidence Dynamics)
// ---------------------------------------------------------------------------

/**
 * CANON-defined confidence thresholds. Treat as constitutional constants --
 * these values cannot be modified by the system at runtime.
 *
 * retrieval:       0.50  — below this a node is not returned by default queries
 * ceiling:         0.60  — hard cap for any node with count === 0 (Standard 3)
 * graduation:      0.80  — confidence required for Type 1 graduation (with MAE < 0.10)
 * demotionMAE:     0.15  — MAE above this triggers Type 1 demotion
 * graduationMAE:   0.10  — MAE below this (combined with confidence) enables graduation
 */
export const CONFIDENCE_THRESHOLDS = {
  retrieval: 0.50,
  ceiling: 0.60,
  graduation: 0.80,
  demotionMAE: 0.15,
  graduationMAE: 0.10,
} as const;

// ---------------------------------------------------------------------------
// Decay Rates
// ---------------------------------------------------------------------------

/**
 * Default decay rate (d) per core provenance type.
 *
 * GUARDIAN knowledge (d=0.03) decays slowest — guardian-taught facts are
 * treated as durable ground truth. LLM_GENERATED (d=0.08) decays fastest —
 * LLM-produced content must be re-validated or it fades. These rates are
 * starting defaults; the Drive Engine may tune them per-node based on
 * behavioral feedback.
 */
export const DEFAULT_DECAY_RATES: Readonly<Record<CoreProvenanceSource, number>> = {
  SENSOR: 0.05,
  GUARDIAN: 0.03,
  LLM_GENERATED: 0.08,
  INFERENCE: 0.06,
} as const;

// ---------------------------------------------------------------------------
// ACT-R Computation
// ---------------------------------------------------------------------------

/**
 * Compute the current ACT-R confidence score for a node or edge.
 *
 * Formula (CANON §Confidence Dynamics):
 *   min(1.0, base + 0.12 * ln(count) - d * ln(hours + 1))
 *
 * Confidence Ceiling (CANON Immutable Standard 3):
 *   If count === 0, the result is clamped to min(ceiling, base). No knowledge
 *   exceeds 0.60 without at least one successful retrieval-and-use event.
 *
 * No Self-Modification (CANON Immutable Standard 6):
 *   This is a pure function. It reads params and returns a number. It has no
 *   side effects and cannot be altered by the system at runtime.
 *
 * @param params - ACT-R parameters for the node or edge
 * @returns Confidence in [0.0, 1.0]
 */
export function computeConfidence(params: ACTRParams): number {
  const { base, count, decayRate, lastRetrievalAt } = params;

  // Confidence Ceiling: never exceed 0.60 for untested knowledge.
  if (count === 0) {
    return Math.min(CONFIDENCE_THRESHOLDS.ceiling, base);
  }

  const hoursSinceRetrieval =
    lastRetrievalAt !== null
      ? (Date.now() - lastRetrievalAt.getTime()) / (1000 * 60 * 60)
      : 0;

  const raw =
    base +
    0.12 * Math.log(count) -
    decayRate * Math.log(hoursSinceRetrieval + 1);

  return Math.min(1.0, Math.max(0.0, raw));
}

// ---------------------------------------------------------------------------
// Guardian Weight
// ---------------------------------------------------------------------------

/**
 * Apply the guardian asymmetry multiplier to a confidence delta.
 *
 * CANON Immutable Standard 5 (Guardian Asymmetry):
 *   - confirmation: 2x weight
 *   - correction:   3x weight
 *
 * This function is applied whenever guardian feedback produces a confidence
 * update. The multiplier is structural — it cannot be reduced by learning.
 *
 * @param confidenceDelta - Raw confidence change before guardian weighting
 * @param feedbackType    - Whether the guardian confirmed or corrected
 * @returns Weighted confidence delta
 */
export function applyGuardianWeight(
  confidenceDelta: number,
  feedbackType: 'confirmation' | 'correction',
): number {
  const multiplier = feedbackType === 'confirmation' ? 2 : 3;
  return confidenceDelta * multiplier;
}

// ---------------------------------------------------------------------------
// Type 1 Graduation / Demotion Checks
// ---------------------------------------------------------------------------

/**
 * Determine whether a behavior qualifies for Type 1 graduation.
 *
 * CANON §Dual-Process Cognition + §Confidence Dynamics:
 * A behavior graduates from Type 2 (LLM-assisted) to Type 1 (graph reflex)
 * when BOTH conditions hold over the last 10 uses:
 *   - confidence > 0.80
 *   - prediction MAE < 0.10
 *
 * Both conditions must be true simultaneously. Confidence alone is
 * insufficient — the behavior must also predict reliably.
 *
 * @param confidence  - Current ACT-R confidence of the behavior node
 * @param recentMAE   - Mean absolute error over the last 10 prediction uses
 * @returns True if the behavior should graduate to Type 1
 */
export function qualifiesForGraduation(confidence: number, recentMAE: number): boolean {
  return (
    confidence > CONFIDENCE_THRESHOLDS.graduation &&
    recentMAE < CONFIDENCE_THRESHOLDS.graduationMAE
  );
}

/**
 * Determine whether a Type 1 behavior should be demoted back to Type 2.
 *
 * CANON §Confidence Dynamics:
 * Demotion triggers when prediction MAE exceeds 0.15 — the behavior is no
 * longer reliably predicting outcomes, indicating the context has changed.
 *
 * @param recentMAE - Mean absolute error over the last 10 prediction uses
 * @returns True if the Type 1 behavior should be demoted to Type 2
 */
export function qualifiesForDemotion(recentMAE: number): boolean {
  return recentMAE > CONFIDENCE_THRESHOLDS.demotionMAE;
}
