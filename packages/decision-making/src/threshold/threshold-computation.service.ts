/**
 * Dynamic action threshold computation service.
 *
 * CANON §Subsystem 1 (Decision Making): The action threshold is a dynamic value
 * that gates Type 1 candidate selection. It starts at the base retrieval threshold
 * (0.50) and is modulated by current drive state:
 *
 * - High anxiety (> 0.70):        raise threshold to ~0.65 (conservative action)
 * - High guilt (> 0.50):          raise threshold to ~0.60 (moral caution)
 * - High curiosity + boredom:     lower threshold to ~0.40 (exploratory mode)
 *
 * The threshold is clamped to [0.30, 0.70] to prevent pathological behavior.
 *
 * CANON §Immutable Standard 1 (Theater Prohibition): The threshold computation
 * is pure — it reads drive state but does not correlate with what Sylphie is
 * currently communicating. The threshold purely gates action selection.
 *
 * Copied nearly verbatim from sylphie-old. Only import paths changed.
 */

import { Injectable, Logger } from '@nestjs/common';
import { type DriveSnapshot, DriveName, CONFIDENCE_THRESHOLDS, type ThresholdResult } from '@sylphie/shared';
import type { IThresholdComputationService } from '../interfaces/decision-making.interfaces';

@Injectable()
export class ThresholdComputationService implements IThresholdComputationService {
  private readonly logger = new Logger(ThresholdComputationService.name);

  /**
   * Compute the dynamic action threshold for the current drive state.
   *
   * Formula:
   *   anxietyMultiplier = 1.0 + 0.3 * max(0, (anxiety - 0.3) / 0.7)
   *   moralMultiplier = 1.0 + 0.2 * max(0, (guilt - 0.3) / 0.7)
   *   curiosityReduction = 1.0 - 0.2 * max(0, min(1, (curiosity - 0.4) / 0.6) * min(1, (boredom - 0.3) / 0.7))
   *   threshold = clamp(BASE * anxietyMultiplier * moralMultiplier * curiosityReduction, 0.30, 0.70)
   *
   * @param driveSnapshot - Current drive state snapshot from Drive Engine
   * @returns ThresholdResult with computed threshold and breakdown components
   */
  computeThreshold(driveSnapshot: DriveSnapshot): ThresholdResult {
    const { pressureVector } = driveSnapshot;

    // Extract relevant drive values
    const anxiety = pressureVector[DriveName.Anxiety];
    const guilt = pressureVector[DriveName.Guilt];
    const curiosity = pressureVector[DriveName.Curiosity];
    const boredom = pressureVector[DriveName.Boredom];

    // Base threshold (CANON retrieval threshold)
    const baseThreshold = CONFIDENCE_THRESHOLDS.retrieval; // 0.50

    // Anxiety multiplier: linear 1.0->1.3 as anxiety goes from 0.3->1.0
    const anxietyMultiplier = 1.0 + 0.3 * Math.max(0, (anxiety - 0.3) / 0.7);

    // Moral (guilt) multiplier: linear 1.0->1.2 as guilt goes from 0.3->1.0
    const moralMultiplier = 1.0 + 0.2 * Math.max(0, (guilt - 0.3) / 0.7);

    // Curiosity reduction: 1.0->0.8 when both curiosity and boredom are high
    const curiosityNorm = Math.min(1.0, Math.max(0, (curiosity - 0.4) / 0.6));
    const boredomNorm = Math.min(1.0, Math.max(0, (boredom - 0.3) / 0.7));
    const curiosityReduction = 1.0 - 0.2 * (curiosityNorm * boredomNorm);

    // Compute raw threshold
    const rawThreshold = baseThreshold * anxietyMultiplier * moralMultiplier * curiosityReduction;

    // Clamp to valid range [0.30, 0.70]
    const MIN_THRESHOLD = 0.3;
    const MAX_THRESHOLD = 0.7;
    const clamped = rawThreshold < MIN_THRESHOLD || rawThreshold > MAX_THRESHOLD;
    const finalThreshold = Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, rawThreshold));

    this.logger.debug(
      `Threshold computation: ` +
        `base=${baseThreshold.toFixed(3)} ` +
        `anxiety=${anxiety.toFixed(3)} (mult=${anxietyMultiplier.toFixed(3)}) ` +
        `guilt=${guilt.toFixed(3)} (mult=${moralMultiplier.toFixed(3)}) ` +
        `curiosity=${curiosity.toFixed(3)} boredom=${boredom.toFixed(3)} (reduction=${curiosityReduction.toFixed(3)}) ` +
        `raw=${rawThreshold.toFixed(3)} final=${finalThreshold.toFixed(3)} ` +
        `clamped=${clamped}`,
    );

    return {
      threshold: finalThreshold,
      baseThreshold,
      anxietyMultiplier,
      moralMultiplier,
      curiosityReduction,
      clamped,
    };
  }
}
