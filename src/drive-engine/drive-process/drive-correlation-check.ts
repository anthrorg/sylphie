/**
 * Drive correlation check: verify emotional expression correlates with drive state.
 *
 * CANON Standard 1 (Theater Prohibition): Output must correlate with actual
 * drive state. This module checks the directionality of expressions:
 *   - Pressure expression (distress, need): drive must be > 0.2 to be authentic
 *   - Relief expression (contentment, calm): drive must be < 0.3 to be authentic
 *
 * If the check fails, the expression is marked as theatrical and receives
 * zero reinforcement.
 */

import type { DriveName } from '../../shared/types/drive.types';

/**
 * Result of a drive correlation check.
 *
 * isAuthentic: true if the expression matches the drive state
 * expressionType: The type of expression checked
 * driveValue: The drive value at expression time
 * reason: Explanation of the verdict
 */
export interface CorrelationCheckResult {
  readonly isAuthentic: boolean;
  readonly expressionType: 'pressure' | 'relief' | 'none';
  readonly driveValue: number;
  readonly reason: string;
}

/**
 * Directional thresholds for expression authenticity (from CANON).
 *
 * Pressure threshold: 0.2
 * Relief threshold: 0.3
 */
export const CORRELATION_THRESHOLDS = {
  pressure: 0.2,    // drive > 0.2 for pressure expression authenticity
  relief: 0.3,      // drive < 0.3 for relief expression authenticity
} as const;

/**
 * Check whether an emotional expression correlates with actual drive state.
 *
 * Uses directional checks:
 *   - Pressure: drive > 0.2 = authentic (expressing actual need)
 *   - Relief: drive < 0.3 = authentic (expressing earned satisfaction)
 *   - None: always authentic (no expression = nothing to check)
 *
 * @param expressionType - Type of expression being checked
 * @param driveValue - The drive value at time of expression
 * @returns CorrelationCheckResult indicating authenticity
 */
export function checkDriveCorrelation(
  expressionType: 'pressure' | 'relief' | 'none',
  driveValue: number,
): CorrelationCheckResult {
  // No expression = always authentic
  if (expressionType === 'none') {
    return {
      isAuthentic: true,
      expressionType,
      driveValue,
      reason: 'No emotional expression produced',
    };
  }

  // Check pressure expressions: need drive > 0.2
  if (expressionType === 'pressure') {
    const isAuthentic = driveValue > CORRELATION_THRESHOLDS.pressure;
    return {
      isAuthentic,
      expressionType,
      driveValue,
      reason: isAuthentic
        ? `Pressure expression authentic (drive ${driveValue} > ${CORRELATION_THRESHOLDS.pressure})`
        : `Pressure expression theatrical (drive ${driveValue} <= ${CORRELATION_THRESHOLDS.pressure})`,
    };
  }

  // Check relief expressions: need drive < 0.3
  if (expressionType === 'relief') {
    const isAuthentic = driveValue < CORRELATION_THRESHOLDS.relief;
    return {
      isAuthentic,
      expressionType,
      driveValue,
      reason: isAuthentic
        ? `Relief expression authentic (drive ${driveValue} < ${CORRELATION_THRESHOLDS.relief})`
        : `Relief expression theatrical (drive ${driveValue} >= ${CORRELATION_THRESHOLDS.relief})`,
    };
  }

  // Should not reach here, but default to authentic if unknown type
  return {
    isAuthentic: true,
    expressionType,
    driveValue,
    reason: 'Unknown expression type, defaulting to authentic',
  };
}
