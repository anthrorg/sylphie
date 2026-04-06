/**
 * ShrugImperativeService — Enforces CANON Immutable Standard 4 (Shrug Imperative).
 *
 * CANON Immutable Standard 4: When no action candidate exceeds the dynamic action
 * threshold, Sylphie signals incomprehension rather than selecting a random low-
 * confidence action. Superstitious behavior is structurally prevented by the
 * ArbitrationResult discriminated union; this service provides the utility layer
 * for producing well-formed SHRUG results with enriched diagnostics.
 *
 * Responsibilities:
 *   - Determine whether a SHRUG should fire (shouldShrug)
 *   - Classify why the SHRUG fired (classifyGapTypes) with named GapType values
 *   - Assemble the fully populated ShrugDetail and ArbitrationResult (createShrugResult)
 *   - Track cumulative SHRUG metrics for attractor monitoring
 *
 * This is a pure utility service: it holds no external DI dependencies. All state
 * is in-memory metrics that can be reset or queried.
 *
 * Improvement over sylphie-old: SHRUG results now carry named gap types and
 * candidateConfidences, giving Communication and Planning actionable downstream
 * information instead of a bare incomprehension signal.
 *
 * Dependencies: @sylphie/shared types only. No external services injected.
 */

import { Injectable } from '@nestjs/common';
import type {
  ArbitrationResult,
  ActionCandidate,
  GapType,
  ShrugDetail,
} from '@sylphie/shared';

// ---------------------------------------------------------------------------
// Metrics shape
// ---------------------------------------------------------------------------

/**
 * Cumulative metrics emitted by the SHRUG Imperative service.
 *
 * Used by AttractorMonitorService to detect whether the system is spending
 * an abnormal fraction of cycles in the SHRUG state (which may indicate
 * MISSING_CONTEXT or LOW_CONFIDENCE gap patterns at systemic scale).
 */
export interface ShrugMetrics {
  /** Total number of SHRUG results produced since last reset. */
  readonly shrugCount: number;

  /**
   * Total candidates rejected across all SHRUG cycles.
   * Allows computing average candidates-per-shrug for diagnostic purposes.
   */
  readonly totalCandidatesRejected: number;
}

// ---------------------------------------------------------------------------
// ShrugImperativeService
// ---------------------------------------------------------------------------

@Injectable()
export class ShrugImperativeService {
  /** Cumulative count of SHRUG results produced. */
  private shrugCount = 0;

  /** Cumulative count of candidates rejected across all SHRUG cycles. */
  private totalCandidatesRejected = 0;

  // ---------------------------------------------------------------------------
  // Core API
  // ---------------------------------------------------------------------------

  /**
   * Determine whether arbitration should produce a SHRUG result.
   *
   * Returns true if no candidate in the array has a confidence value that
   * meets or exceeds the provided threshold. An empty candidate array always
   * returns true.
   *
   * This method has no side effects and does not update metrics. Call
   * createShrugResult() to produce the result and update metrics.
   *
   * @param candidates - The action candidates evaluated during arbitration.
   * @param threshold  - The dynamic action threshold for this cycle.
   * @returns True if SHRUG should fire; false if at least one candidate qualifies.
   */
  shouldShrug(candidates: readonly ActionCandidate[], threshold: number): boolean {
    if (candidates.length === 0) {
      return true;
    }
    return candidates.every((c) => c.confidence < threshold);
  }

  /**
   * Create an ArbitrationResult of type 'SHRUG' with enriched ShrugDetail.
   *
   * Assembles the SHRUG result with:
   *   - reason: a human-readable explanation of why no candidate was selected
   *   - shrugDetail: structured diagnostic data with named gap types, candidate
   *     confidences, and the dynamic threshold
   *
   * Also updates cumulative metrics (shrugCount, totalCandidatesRejected).
   *
   * CANON Standard 4: The caller is responsible for ensuring shouldShrug()
   * returned true before calling this method. This method does not re-check
   * the threshold condition.
   *
   * @param candidates - Candidates that were evaluated and rejected.
   * @param threshold  - The dynamic action threshold that was applied.
   * @param gapTypes   - Pre-classified gap types (from classifyGapTypes()).
   * @returns An ArbitrationResult with type 'SHRUG' and populated shrugDetail.
   */
  createShrugResult(
    candidates: readonly ActionCandidate[],
    threshold: number,
    gapTypes: readonly GapType[],
  ): ArbitrationResult {
    const candidateConfidences = candidates.map((c) => c.confidence);
    const maxConfidence = candidateConfidences.length > 0
      ? Math.max(...candidateConfidences)
      : 0;

    const reason =
      candidateConfidences.length === 0
        ? `No action candidates retrieved for this context (threshold: ${threshold.toFixed(3)}).`
        : `No candidates exceeded threshold. Max confidence: ${maxConfidence.toFixed(3)}, ` +
          `threshold: ${threshold.toFixed(3)}, candidates evaluated: ${candidates.length}.`;

    const shrugDetail: ShrugDetail = {
      gapTypes,
      candidateConfidences,
      threshold,
      reason,
    };

    // Update metrics
    this.shrugCount += 1;
    this.totalCandidatesRejected += candidates.length;

    return {
      type: 'SHRUG',
      reason,
      shrugDetail,
    };
  }

  /**
   * Classify why a SHRUG fired, returning one or more named GapType values.
   *
   * Current classification logic:
   *   - No candidates at all → [MISSING_CONTEXT] (the situation is entirely novel;
   *     no procedure nodes matched the context fingerprint above retrieval threshold)
   *   - All candidates below threshold → [LOW_CONFIDENCE] (candidates exist in the
   *     WKG but none have accumulated sufficient confidence for this context)
   *
   * This method is intentionally simple now. Richer gap classification (e.g.,
   * AMBIGUOUS_REFERENCE when multiple candidates have near-identical confidence,
   * CONTRADICTION when a contradiction scan fires before threshold check) is
   * injected by the caller at the arbitration layer, which has the full context
   * to detect those conditions before calling createShrugResult().
   *
   * @param candidates - Candidates evaluated during arbitration (may be empty).
   * @param threshold  - The dynamic action threshold that was applied.
   * @returns An array of one or more GapType values explaining the SHRUG.
   */
  classifyGapTypes(candidates: readonly ActionCandidate[], threshold: number): readonly GapType[] {
    void threshold; // threshold is unused here but accepted for API symmetry and future use

    if (candidates.length === 0) {
      return ['MISSING_CONTEXT'];
    }

    // All candidates exist but none cleared the threshold
    return ['LOW_CONFIDENCE'];
  }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  /**
   * Return the current cumulative SHRUG metrics.
   *
   * Metrics accumulate across the lifetime of the service instance (i.e.,
   * across all decision cycles since module initialization or last reset).
   * AttractorMonitorService reads these to detect pathological SHRUG rates.
   *
   * @returns A read-only snapshot of current SHRUG metrics.
   */
  getMetrics(): ShrugMetrics {
    return {
      shrugCount: this.shrugCount,
      totalCandidatesRejected: this.totalCandidatesRejected,
    };
  }

  /**
   * Reset cumulative metrics to zero.
   *
   * Used by AttractorMonitorService after reading metrics for a reporting
   * interval, or by tests to ensure a clean baseline between test cases.
   */
  resetMetrics(): void {
    this.shrugCount = 0;
    this.totalCandidatesRejected = 0;
  }
}
