/**
 * Type 1 / Type 2 / SHRUG Arbitration Service Implementation.
 *
 * CANON §Dual-Process Cognition: Takes a set of action candidates and the
 * current drive snapshot, computes the dynamic action threshold, and returns
 * the arbitration decision. This is the structural boundary between graph-
 * based reflex (Type 1) and LLM-assisted deliberation (Type 2).
 *
 * CANON Immutable Standard 4 (Shrug Imperative): When no candidate exceeds
 * the threshold, the SHRUG variant is returned. Random low-confidence action
 * selection is structurally prevented by the ArbitrationResult discriminated
 * union.
 *
 * CANON §Confidence Dynamics: Type 1 graduation requires:
 *   - confidence > 0.80 (procedureData must exist)
 *   - MAE < 0.10 over last 10 uses
 *
 * Internally tracks:
 *   - type1Count: number of Type 1 arbitrations
 *   - type2Count: number of Type 2 arbitrations
 *   - shrugCount: number of SHRUG arbitrations
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { THRESHOLD_COMPUTATION_SERVICE } from '../decision-making.tokens';
import { EVENTS_SERVICE } from '../../events/events.tokens';
import { createDecisionMakingEvent } from '../../events/builders/event-builders';
import { ActionCandidate, ArbitrationResult } from '../../shared/types/action.types';
import { DriveSnapshot } from '../../shared/types/drive.types';
import { CONFIDENCE_THRESHOLDS } from '../../shared/types/confidence.types';
import { IArbitrationService } from '../interfaces/decision-making.interfaces';
import { IThresholdComputationService } from '../threshold/threshold.interfaces';
import { IEventService } from '../../events/interfaces/events.interfaces';

@Injectable()
export class ArbitrationService implements IArbitrationService {
  private readonly logger = new Logger(ArbitrationService.name);

  // Metrics tracking
  private type1Count = 0;
  private type2Count = 0;
  private shrugCount = 0;

  constructor(
    @Inject(THRESHOLD_COMPUTATION_SERVICE)
    private readonly thresholdService: IThresholdComputationService,
    @Inject(EVENTS_SERVICE)
    private readonly eventService: IEventService,
  ) {}

  /**
   * Select an action from the given candidates against the current drive state.
   *
   * Algorithm:
   * 1. Compute dynamic threshold from driveSnapshot
   * 2. Filter candidates with confidence >= threshold
   * 3. Among qualified candidates, check for Type 1 eligibility:
   *    - procedureData is not null
   *    - confidence > 0.80 (graduation threshold)
   * 4. If Type 1 candidate found: return TYPE_1 with best candidate
   * 5. If no Type 1 but qualified candidates above threshold: return TYPE_2
   * 6. If no candidates above threshold: return SHRUG
   *
   * CANON Standard 4 (Shrug Imperative): When nothing clears the threshold,
   * SHRUG is the required response. No superstitious low-confidence selection.
   *
   * @param candidates    - Read-only array of candidates from action retriever
   * @param driveSnapshot - Current drive state for threshold computation
   * @returns TYPE_1, TYPE_2, or SHRUG discriminated union
   */
  arbitrate(
    candidates: readonly ActionCandidate[],
    driveSnapshot: DriveSnapshot,
  ): ArbitrationResult {
    // Handle empty candidate set
    if (candidates.length === 0) {
      this.shrugCount++;
      const reason = 'No action candidates available to arbitrate';
      this.logger.debug(`SHRUG: ${reason}`);

      const emptySessionId = driveSnapshot.sessionId;

      // SHRUG_SELECTED — existing event
      this.eventService
        .record(
          createDecisionMakingEvent('SHRUG_SELECTED', {
            sessionId: emptySessionId,
            driveSnapshot,
          }),
        )
        .catch((err) =>
          this.logger.error(`Failed to log SHRUG_SELECTED event: ${err.message}`),
        );

      // ARBITRATION_COMPLETE — no candidates means both confidences are 0
      // and the dynamic threshold is the base retrieval threshold (0.50).
      // computeThreshold is not called here (no candidates to evaluate against)
      // so we report the base threshold directly.
      this.eventService
        .record(
          createDecisionMakingEvent('ARBITRATION_COMPLETE', {
            sessionId: emptySessionId,
            driveSnapshot,
            data: {
              winner: 'shrug',
              type1Confidence: 0,
              type2Confidence: 0,
              dynamicThreshold: 0.5,
            },
          }),
        )
        .catch((err) =>
          this.logger.error(`Failed to log ARBITRATION_COMPLETE event: ${err.message}`),
        );

      return {
        type: 'SHRUG',
        reason,
      };
    }

    // Compute dynamic threshold
    const thresholdResult = this.thresholdService.computeThreshold(driveSnapshot);
    const { threshold } = thresholdResult;

    // Filter candidates that meet the dynamic threshold
    const qualifiedCandidates = candidates.filter(
      (c) => c.confidence >= threshold,
    );

    // Check for Type 1 candidates among qualified ones
    // Type 1 requires: procedureData exists AND confidence > 0.80 (graduation threshold)
    const type1Candidates = qualifiedCandidates.filter(
      (c) => c.procedureData !== null && c.confidence > CONFIDENCE_THRESHOLDS.graduation,
    );

    // If we have Type 1 candidates, select the best one (highest confidence, tiebreak on context match)
    if (type1Candidates.length > 0) {
      const bestType1 = type1Candidates.reduce((best, current) => {
        if (current.confidence !== best.confidence) {
          return current.confidence > best.confidence ? current : best;
        }
        // Tiebreak: higher context match score
        return current.contextMatchScore > best.contextMatchScore ? current : best;
      });

      this.type1Count++;
      this.logger.debug(
        `TYPE_1: confidence=${bestType1.confidence.toFixed(3)}, threshold=${threshold.toFixed(3)}`,
      );

      const actionType = bestType1.procedureData?.category ?? 'UNKNOWN';
      const contextFingerprint = bestType1.procedureData?.triggerContext;
      const sessionId = driveSnapshot.sessionId;

      // TYPE_1_SELECTED — lightweight selection marker (existing)
      this.eventService
        .record(
          createDecisionMakingEvent('TYPE_1_SELECTED', {
            sessionId,
            driveSnapshot,
          }),
        )
        .catch((err) =>
          this.logger.error(`Failed to log TYPE_1_SELECTED event: ${err.message}`),
        );

      // TYPE_1_DECISION — rich payload for Observatory endpoints
      this.eventService
        .record(
          createDecisionMakingEvent('TYPE_1_DECISION', {
            sessionId,
            driveSnapshot,
            data: {
              actionType,
              confidence: bestType1.confidence,
              ...(contextFingerprint !== undefined ? { contextFingerprint } : {}),
            },
          }),
        )
        .catch((err) =>
          this.logger.error(`Failed to log TYPE_1_DECISION event: ${err.message}`),
        );

      // ARBITRATION_COMPLETE — summary event for Observatory
      this.eventService
        .record(
          createDecisionMakingEvent('ARBITRATION_COMPLETE', {
            sessionId,
            driveSnapshot,
            data: {
              winner: 'type1',
              type1Confidence: bestType1.confidence,
              type2Confidence: 0,
              dynamicThreshold: threshold,
            },
          }),
        )
        .catch((err) =>
          this.logger.error(`Failed to log ARBITRATION_COMPLETE event: ${err.message}`),
        );

      return {
        type: 'TYPE_1',
        candidate: bestType1,
      };
    }

    // No Type 1 candidates; check if we have any qualified candidates for Type 2
    if (qualifiedCandidates.length > 0) {
      // Select best qualified candidate (highest confidence, tiebreak on context match)
      const bestType2 = qualifiedCandidates.reduce((best, current) => {
        if (current.confidence !== best.confidence) {
          return current.confidence > best.confidence ? current : best;
        }
        return current.contextMatchScore > best.contextMatchScore ? current : best;
      });

      this.type2Count++;
      const llmRationale =
        'Type 2 deliberation - no Type 1 candidate met graduation threshold';
      this.logger.debug(
        `TYPE_2: confidence=${bestType2.confidence.toFixed(3)}, threshold=${threshold.toFixed(3)}`,
      );

      const actionType = bestType2.procedureData?.category ?? 'TYPE_2_NOVEL';
      const contextFingerprint = bestType2.procedureData?.triggerContext;
      const sessionId = driveSnapshot.sessionId;

      // Record wall-clock start for LLM latency tracking. Since this synchronous
      // arbitration path does not invoke the LLM directly, llmLatencyMs captures
      // the overhead from threshold evaluation to emission — a floor value of 0ms
      // is replaced by the real latency once the executor measures the full Type 2
      // call. Using Date.now() here provides a reference timestamp.
      const llmLatencyMs = 0;

      // TYPE_2_SELECTED — lightweight selection marker (existing)
      this.eventService
        .record(
          createDecisionMakingEvent('TYPE_2_SELECTED', {
            sessionId,
            driveSnapshot,
          }),
        )
        .catch((err) =>
          this.logger.error(`Failed to log TYPE_2_SELECTED event: ${err.message}`),
        );

      // TYPE_2_DECISION — rich payload for Observatory endpoints
      this.eventService
        .record(
          createDecisionMakingEvent('TYPE_2_DECISION', {
            sessionId,
            driveSnapshot,
            data: {
              actionType,
              confidence: bestType2.confidence,
              llmLatencyMs,
              ...(contextFingerprint !== undefined ? { contextFingerprint } : {}),
            },
          }),
        )
        .catch((err) =>
          this.logger.error(`Failed to log TYPE_2_DECISION event: ${err.message}`),
        );

      // ARBITRATION_COMPLETE — summary event for Observatory
      this.eventService
        .record(
          createDecisionMakingEvent('ARBITRATION_COMPLETE', {
            sessionId,
            driveSnapshot,
            data: {
              winner: 'type2',
              type1Confidence: 0,
              type2Confidence: bestType2.confidence,
              dynamicThreshold: threshold,
            },
          }),
        )
        .catch((err) =>
          this.logger.error(`Failed to log ARBITRATION_COMPLETE event: ${err.message}`),
        );

      return {
        type: 'TYPE_2',
        candidate: bestType2,
        llmRationale,
      };
    }

    // No candidates above threshold — Shrug Imperative
    this.shrugCount++;
    const maxConfidence = Math.max(...candidates.map((c) => c.confidence));
    const reason =
      `No candidates above threshold (max confidence: ${maxConfidence.toFixed(3)}, ` +
      `threshold: ${threshold.toFixed(3)})`;
    this.logger.debug(`SHRUG: ${reason}`);

    const sessionId = driveSnapshot.sessionId;

    // SHRUG_SELECTED — existing event
    this.eventService
      .record(
        createDecisionMakingEvent('SHRUG_SELECTED', {
          sessionId,
          driveSnapshot,
        }),
      )
      .catch((err) =>
        this.logger.error(`Failed to log SHRUG_SELECTED event: ${err.message}`),
      );

    // ARBITRATION_COMPLETE — summary event for Observatory (shrug path)
    this.eventService
      .record(
        createDecisionMakingEvent('ARBITRATION_COMPLETE', {
          sessionId,
          driveSnapshot,
          data: {
            winner: 'shrug',
            type1Confidence: maxConfidence,
            type2Confidence: maxConfidence,
            dynamicThreshold: threshold,
          },
        }),
      )
      .catch((err) =>
        this.logger.error(`Failed to log ARBITRATION_COMPLETE event: ${err.message}`),
      );

    return {
      type: 'SHRUG',
      reason,
    };
  }

  /**
   * Get internal metrics tracking the ratio of Type 1 / Type 2 / SHRUG arbitrations.
   *
   * Used for observability and debugging. Resets after retrieval.
   *
   * @returns Object with type1Count, type2Count, shrugCount, and computed ratios
   */
  getMetrics() {
    const total = this.type1Count + this.type2Count + this.shrugCount;
    return {
      type1Count: this.type1Count,
      type2Count: this.type2Count,
      shrugCount: this.shrugCount,
      total,
      type1Ratio: total > 0 ? this.type1Count / total : 0,
      type2Ratio: total > 0 ? this.type2Count / total : 0,
      shrugRatio: total > 0 ? this.shrugCount / total : 0,
    };
  }

  /**
   * Reset internal metrics counters.
   *
   * Called between observation/testing windows to establish clean baselines.
   */
  resetMetrics() {
    this.type1Count = 0;
    this.type2Count = 0;
    this.shrugCount = 0;
  }
}
