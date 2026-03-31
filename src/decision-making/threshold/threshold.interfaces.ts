/**
 * Threshold computation service interface.
 *
 * CANON §Subsystem 1 (Decision Making): The action threshold gates which
 * Type 1 candidates are actionable during arbitration. It is computed from
 * the current drive state and clamped to [0.30, 0.70].
 *
 * This interface is re-exported from decision-making.interfaces.ts for
 * consistency with the module's interface organization pattern.
 */

import type { DriveSnapshot } from '../../shared/types/drive.types';

/**
 * Result of a dynamic threshold computation.
 *
 * Returned by IThresholdComputationService.computeThreshold(). Carries the
 * final computed threshold and intermediate multiplier values for debugging
 * and logging.
 */
export interface ThresholdResult {
  /** The computed action threshold in [0.30, 0.70]. */
  readonly threshold: number;

  /** Base threshold before drive modulation (CONFIDENCE_THRESHOLDS.retrieval = 0.50). */
  readonly baseThreshold: number;

  /**
   * Anxiety modulation multiplier in [1.0, 1.3].
   * Higher anxiety → higher threshold (conservative action selection).
   */
  readonly anxietyMultiplier: number;

  /**
   * Moral/guilt modulation multiplier in [1.0, 1.2].
   * Higher guilt → higher threshold (moral caution).
   */
  readonly moralMultiplier: number;

  /**
   * Curiosity + boredom reduction factor in [0.8, 1.0].
   * When both curiosity and boredom are high → lower threshold (exploratory mode).
   */
  readonly curiosityReduction: number;

  /**
   * Whether the raw threshold was clamped to [0.30, 0.70].
   * True if the raw computed value exceeded the bounds.
   */
  readonly clamped: boolean;
}

/**
 * Interface for computing dynamic action thresholds.
 *
 * CANON §Subsystem 1 (Decision Making): The action threshold gates which
 * Type 1 candidates are actionable during arbitration. It is computed from
 * the current drive state and clamped to [0.30, 0.70].
 *
 * Injection token: THRESHOLD_COMPUTATION_SERVICE (decision-making.tokens.ts)
 * Provided by:    ThresholdComputationService
 */
export interface IThresholdComputationService {
  /**
   * Compute the dynamic action threshold for the current drive state.
   *
   * Applies drive-based modulations:
   * - Anxiety > 0.70:              raise threshold (conservative)
   * - Guilt > 0.50:                raise threshold (moral caution)
   * - Curiosity + Boredom high:    lower threshold (exploration)
   *
   * Result is clamped to [0.30, 0.70].
   *
   * @param driveSnapshot - Current drive state for modulation.
   * @returns ThresholdResult with threshold and intermediate values.
   */
  computeThreshold(driveSnapshot: DriveSnapshot): ThresholdResult;
}
