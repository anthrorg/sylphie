/**
 * ArbitrationService — Type 1 / Type 2 / SHRUG decision arbitration.
 *
 * CANON §Dual-Process Cognition: Evaluates action candidates against the
 * dynamic threshold and produces exactly one of three outcomes:
 *   TYPE_1  — A graph-based reflex candidate exceeded the threshold.
 *   TYPE_2  — No Type 1 candidate cleared threshold; LLM deliberation path.
 *   SHRUG   — No candidate was actionable. Shrug Imperative applied.
 *
 * CANON Immutable Standard 4 (Shrug Imperative): Random low-confidence
 * selection is structurally prevented. The ArbitrationResult discriminated
 * union enforces this at the type level.
 *
 * Improvement over sylphie-old: arbitrate() is now async to support
 * contradiction scanning (co-being Validation Phase). The SHRUG variant
 * carries a ShrugDetail with named GapTypes and candidate metrics so
 * Communication and Planning can act on specific incomprehension types.
 *
 * Metrics (type1Count, type2Count, shrugCount) are accumulated across cycles
 * and exposed via getMetrics() for attractor state detection.
 */

import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import {
  type ActionCandidate,
  type ArbitrationResult,
  type DriveSnapshot,
  type ShrugDetail,
  CONFIDENCE_THRESHOLDS,
} from '@sylphie/shared';
import type {
  IArbitrationService,
  IThresholdComputationService,
  IContradictionScannerService,
  IDecisionEventLogger,
} from '../interfaces/decision-making.interfaces';
import {
  THRESHOLD_COMPUTATION_SERVICE,
  CONTRADICTION_SCANNER,
  DECISION_EVENT_LOGGER,
} from '../decision-making.tokens';

// ---------------------------------------------------------------------------
// Arbitration Metrics
// ---------------------------------------------------------------------------

/**
 * Accumulated counts of each arbitration outcome for this service lifetime.
 * Used by attractor state detection (TYPE_2_ADDICT attractor).
 */
export interface ArbitrationMetrics {
  readonly type1Count: number;
  readonly type2Count: number;
  readonly shrugCount: number;
}

// ---------------------------------------------------------------------------
// ArbitrationService
// ---------------------------------------------------------------------------

@Injectable()
export class ArbitrationService implements IArbitrationService {
  private readonly logger = new Logger(ArbitrationService.name);

  private _type1Count = 0;
  private _type2Count = 0;
  private _shrugCount = 0;

  constructor(
    @Optional()
    @Inject(THRESHOLD_COMPUTATION_SERVICE)
    private readonly thresholdService: IThresholdComputationService | null,

    @Optional()
    @Inject(CONTRADICTION_SCANNER)
    private readonly contradictionScanner: IContradictionScannerService | null,

    @Optional()
    @Inject(DECISION_EVENT_LOGGER)
    private readonly eventLogger: IDecisionEventLogger | null,
  ) {}

  /**
   * Select an action from the given candidates against the current drive state.
   *
   * Algorithm:
   *   1. Empty candidates     → SHRUG (GapType.MISSING_CONTEXT)
   *   2. Compute dynamic threshold via THRESHOLD_COMPUTATION_SERVICE (fallback: 0.50)
   *   3. Filter candidates >= threshold
   *   4. Find best Type 1 candidate: procedureData !== null AND confidence > graduation (0.80)
   *   5. If Type 1 found → scan for contradictions; if found → SHRUG (GapType.CONTRADICTION)
   *   6. If Type 1 found, no contradictions → return TYPE_1
   *   7. If qualified candidates exist but no Type 1 → return TYPE_2
   *   8. No candidates above threshold → SHRUG (GapType.LOW_CONFIDENCE)
   *
   * Tiebreaker on qualified candidates: confidence desc, then contextMatchScore desc.
   *
   * @param candidates    - Candidates from IActionRetrieverService.
   * @param driveSnapshot - Current drive state for threshold computation and logging.
   * @returns TYPE_1, TYPE_2, or SHRUG discriminated union.
   */
  async arbitrate(
    candidates: readonly ActionCandidate[],
    driveSnapshot: DriveSnapshot,
  ): Promise<ArbitrationResult> {
    // Step 1: Empty candidate list — novel context, nothing in WKG.
    if (candidates.length === 0) {
      return this.buildShrug(
        candidates,
        driveSnapshot,
        'No candidates retrieved for this context.',
        ['MISSING_CONTEXT'],
        0,
      );
    }

    // Step 2: Compute dynamic threshold.
    let threshold: number = CONFIDENCE_THRESHOLDS.retrieval;
    if (this.thresholdService ) {
      const thresholdResult = this.thresholdService.computeThreshold(driveSnapshot);
      threshold = thresholdResult.threshold;
    } else {
      this.logger.debug(
        'THRESHOLD_COMPUTATION_SERVICE unavailable, using static retrieval threshold (0.50)',
      );
    }

    // Step 3: Filter candidates that meet the threshold.
    const qualified = candidates
      .filter((c) => c.confidence >= threshold)
      .slice()
      .sort((a, b) => {
        // Primary sort: confidence descending.
        const confDiff = b.confidence - a.confidence;
        if (Math.abs(confDiff) > 1e-9) {
          return confDiff;
        }
        // Tiebreaker: contextMatchScore descending.
        return b.contextMatchScore - a.contextMatchScore;
      });

    if (qualified.length === 0) {
      // No candidates cleared the threshold.
      const candidateConfidences = candidates.map((c) => c.confidence);
      const maxConf = Math.max(...candidateConfidences);

      this.logger.debug(
        `Arbitration SHRUG (LOW_CONFIDENCE): ${candidates.length} candidates, ` +
          `max confidence=${maxConf.toFixed(3)}, threshold=${threshold.toFixed(3)}`,
      );

      return this.buildShrug(
        candidates,
        driveSnapshot,
        `No candidates exceeded threshold ${threshold.toFixed(3)} (max confidence: ${maxConf.toFixed(3)}).`,
        ['LOW_CONFIDENCE'],
        threshold,
      );
    }

    // Step 4: Find the best Type 1 candidate.
    // Type 1 requires: procedureData is present AND confidence > graduation threshold (0.80).
    const bestType1 = qualified.find(
      (c) =>
        c.procedureData !== null &&
        c.confidence > CONFIDENCE_THRESHOLDS.graduation,
    ) ?? null;

    if (bestType1 ) {
      // Step 5: Contradiction scan before committing TYPE_1.
      if (this.contradictionScanner ) {
        const scanResult = await this.contradictionScanner.scan(bestType1, driveSnapshot);

        if (scanResult.hasContradictions) {
          this.logger.warn(
            `Arbitration SHRUG (CONTRADICTION): Type 1 candidate "${bestType1.procedureData!.name}" ` +
              `has ${scanResult.contradictions.length} contradiction(s). Downgrading to SHRUG.`,
          );

          const result = this.buildShrug(
            candidates,
            driveSnapshot,
            `Type 1 candidate "${bestType1.procedureData!.name}" activates contradictory WKG beliefs.`,
            ['CONTRADICTION'],
            threshold,
          );

          this.logEvent('SHRUG_SELECTED', { gapTypes: ['CONTRADICTION'], threshold }, driveSnapshot);
          return result;
        }
      }

      // Step 6: Clean TYPE_1.
      this._type1Count++;

      this.logger.debug(
        `Arbitration TYPE_1: "${bestType1.procedureData!.name}" ` +
          `confidence=${bestType1.confidence.toFixed(3)} threshold=${threshold.toFixed(3)}`,
      );

      this.logEvent(
        'TYPE_1_SELECTED',
        {
          procedureId: bestType1.procedureData!.id,
          procedureName: bestType1.procedureData!.name,
          confidence: bestType1.confidence,
          threshold,
        },
        driveSnapshot,
      );

      this.logEvent('ARBITRATION_COMPLETE', { type: 'TYPE_1', threshold }, driveSnapshot);

      return { type: 'TYPE_1', candidate: bestType1 };
    }

    // Step 7: Qualified candidates exist but none meet Type 1 graduation.
    // Return the best qualified candidate via TYPE_2 path.
    const bestType2 = qualified[0];
    this._type2Count++;

    this.logger.debug(
      `Arbitration TYPE_2: best candidate confidence=${bestType2.confidence.toFixed(3)}, ` +
        `threshold=${threshold.toFixed(3)}, total qualified=${qualified.length}`,
    );

    this.logEvent(
      'TYPE_2_SELECTED',
      {
        candidateConfidence: bestType2.confidence,
        threshold,
        qualifiedCount: qualified.length,
        procedureId: bestType2.procedureData?.id ?? null,
      },
      driveSnapshot,
    );

    this.logEvent('ARBITRATION_COMPLETE', { type: 'TYPE_2', threshold }, driveSnapshot);

    return {
      type: 'TYPE_2',
      candidate: bestType2,
      // The llmRationale placeholder. The Communication subsystem fills this
      // during actual LLM deliberation; we do not call the LLM here.
      llmRationale: 'Pending LLM deliberation — no Type 1 candidate exceeded graduation threshold.',
    };
  }

  /**
   * Return accumulated arbitration outcome counts.
   * Used by AttractorMonitorService to detect TYPE_2_ADDICT state.
   *
   * @returns Snapshot of current metric counts.
   */
  getMetrics(): ArbitrationMetrics {
    return {
      type1Count: this._type1Count,
      type2Count: this._type2Count,
      shrugCount: this._shrugCount,
    };
  }

  /**
   * Reset all outcome counters to zero.
   * Called by AttractorMonitorService after reporting a measurement window.
   */
  resetMetrics(): void {
    this._type1Count = 0;
    this._type2Count = 0;
    this._shrugCount = 0;
    this.logger.debug('Arbitration metrics reset.');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a SHRUG result with structured ShrugDetail.
   *
   * Increments shrugCount, emits SHRUG_SELECTED and ARBITRATION_COMPLETE events.
   */
  private buildShrug(
    candidates: readonly ActionCandidate[],
    driveSnapshot: DriveSnapshot,
    reason: string,
    gapTypes: ShrugDetail['gapTypes'],
    threshold: number,
  ): ArbitrationResult & { type: 'SHRUG' } {
    this._shrugCount++;

    const candidateConfidences = candidates.map((c) => c.confidence);

    const shrugDetail: ShrugDetail = {
      gapTypes,
      candidateConfidences,
      threshold,
      reason,
    };

    this.logEvent(
      'SHRUG_SELECTED',
      { gapTypes, threshold, candidateCount: candidates.length },
      driveSnapshot,
    );

    this.logEvent('ARBITRATION_COMPLETE', { type: 'SHRUG', gapTypes, threshold }, driveSnapshot);

    return { type: 'SHRUG', reason, shrugDetail };
  }

  /**
   * Emit a decision event via the logger if available.
   * Soft failure: logs a warning but does not throw on logger absence.
   */
  private logEvent(
    eventType: string,
    payload: Record<string, unknown>,
    driveSnapshot: DriveSnapshot,
  ): void {
    if (this.eventLogger ) {
      try {
        this.eventLogger.log(eventType, payload, driveSnapshot, driveSnapshot.sessionId);
      } catch (err) {
        this.logger.warn(`Failed to emit arbitration event (${eventType}): ${err}`);
      }
    }
  }
}
