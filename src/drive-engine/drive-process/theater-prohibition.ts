/**
 * Theater Prohibition enforcement: verify emotional expressions match drive state.
 *
 * CANON Standard 1 (Theater Prohibition): Output must correlate with actual
 * drive state. Expressions of emotion without corresponding drive pressure
 * receive zero reinforcement.
 *
 * This module performs both pre-flight (trust Communication's check) and
 * post-flight verification (validate drive state at outcome time) to ensure
 * emotional expressions are authentic.
 */

import type { DriveName } from '../../shared/types/drive.types';
import type { ActionOutcomePayload } from '../../shared/types/ipc.types';
import type { PressureVector } from '../../shared/types/drive.types';

/**
 * Result of a Theater Prohibition check.
 *
 * isTheatrical: true if the expression was not authentic (failed drive check)
 * reason: Human-readable explanation of the verdict
 * expressionType: The type of expression ('pressure', 'relief', or 'none')
 * drive: The drive involved in the expression
 * driveValue: The drive value at the time of expression
 */
export interface TheaterVerdict {
  readonly isTheatrical: boolean;
  readonly reason: string;
  readonly expressionType: 'pressure' | 'relief' | 'none';
  readonly drive: DriveName;
  readonly driveValue: number;
}

/**
 * Thresholds for directional drive checks (from CANON §Theater Prohibition).
 *
 * Pressure expressions (distress, need, urgency) require drive > pressureThreshold
 * Relief expressions (contentment, calm) require drive < reliefThreshold
 */
const PRESSURE_THRESHOLD = 0.2;   // drive > 0.2 for pressure to be authentic
const RELIEF_THRESHOLD = 0.3;     // drive < 0.3 for relief to be authentic

/**
 * Perform theater detection on an action outcome.
 *
 * Receives the theaterCheck data from the ACTION_OUTCOME payload and verifies
 * that any emotional expression matches the actual drive state. If the
 * expression was pre-validated by Communication, we still perform post-flight
 * verification to catch edge cases (drive value changed between dispatch and
 * outcome).
 *
 * @param theaterCheck - The theater check data from ActionOutcomePayload
 * @param currentDriveState - Current drive snapshot for post-flight verification
 * @returns A TheaterVerdict indicating whether the expression was authentic
 */
export function detectTheater(
  theaterCheck: {
    readonly expressionType: 'pressure' | 'relief' | 'none';
    readonly driveValueAtExpression: number;
    readonly drive: DriveName;
    readonly isTheatrical: boolean;
  },
  currentDriveState: PressureVector,
): TheaterVerdict {
  const { expressionType, driveValueAtExpression, drive } = theaterCheck;

  // If no expression was produced, it's not theatrical
  if (expressionType === 'none') {
    return {
      isTheatrical: false,
      reason: 'No emotional expression produced',
      expressionType,
      drive,
      driveValue: driveValueAtExpression,
    };
  }

  // Perform directional check based on expression type
  const isAuthenticPressure = verifyPressureExpression(driveValueAtExpression);
  const isAuthenticRelief = verifyReliefExpression(driveValueAtExpression);

  if (expressionType === 'pressure' && !isAuthenticPressure) {
    return {
      isTheatrical: true,
      reason: `Pressure expression (${drive}) requires drive > ${PRESSURE_THRESHOLD}, but was ${driveValueAtExpression}`,
      expressionType,
      drive,
      driveValue: driveValueAtExpression,
    };
  }

  if (expressionType === 'relief' && !isAuthenticRelief) {
    return {
      isTheatrical: true,
      reason: `Relief expression (${drive}) requires drive < ${RELIEF_THRESHOLD}, but was ${driveValueAtExpression}`,
      expressionType,
      drive,
      driveValue: driveValueAtExpression,
    };
  }

  // Expression passed directional check
  return {
    isTheatrical: false,
    reason: `${expressionType} expression is authentic (drive value: ${driveValueAtExpression})`,
    expressionType,
    drive,
    driveValue: driveValueAtExpression,
  };
}

/**
 * Verify that a pressure expression is authentic.
 *
 * A pressure expression (expressing distress, need, urgency) is authentic
 * only if the drive value is above the pressure threshold (> 0.2).
 *
 * @param driveValue - The drive value at time of expression
 * @returns true if the expression is authentic
 */
function verifyPressureExpression(driveValue: number): boolean {
  return driveValue > PRESSURE_THRESHOLD;
}

/**
 * Verify that a relief expression is authentic.
 *
 * A relief expression (expressing contentment, calm, fulfillment) is authentic
 * only if the drive value is below the relief threshold (< 0.3).
 *
 * @param driveValue - The drive value at time of expression
 * @returns true if the expression is authentic
 */
function verifyReliefExpression(driveValue: number): boolean {
  return driveValue < RELIEF_THRESHOLD;
}
