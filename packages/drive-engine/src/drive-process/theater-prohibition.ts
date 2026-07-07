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

import type { DriveName } from '@sylphie/shared';
import type { ActionOutcomePayload } from '@sylphie/shared';
import type { PressureVector } from '@sylphie/shared';
import { verboseFor } from '@sylphie/shared';

const vlog = verboseFor('DriveEngine');

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
export const PRESSURE_THRESHOLD = 0.2;   // drive > 0.2 for pressure to be authentic
export const RELIEF_THRESHOLD = 0.3;     // drive < 0.3 for relief to be authentic

/**
 * Perform theater detection on an action outcome.
 *
 * Receives the theaterCheck data from the ACTION_OUTCOME payload and verifies
 * that any emotional expression matches the drive engine's OWN isolated drive
 * state at verification time (currentDriveState) — not the caller-supplied
 * driveValueAtExpression. The caller-supplied value is untrusted testimony
 * (CANON Standard 1 — Theater Prohibition: the isolated judge must not trust
 * the defendant); currentDriveState is the engine's actual record.
 *
 * @param theaterCheck - The theater check data from ActionOutcomePayload
 * @param currentDriveState - The engine's actual isolated drive state, used for the verdict
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

  // Verdict is derived from the engine's own isolated drive state, not the
  // caller-supplied driveValueAtExpression (post-flight verification).
  const isolatedDriveValue = currentDriveState[drive];
  const isAuthenticPressure = verifyPressureExpression(isolatedDriveValue);
  const isAuthenticRelief = verifyReliefExpression(isolatedDriveValue);

  if (expressionType === 'pressure' && !isAuthenticPressure) {
    vlog('theater check', {
      expressionType,
      drive,
      driveValueAtExpression,
      isolatedDriveValue,
      verdict: 'theatrical',
      reason: `isolated drive ${isolatedDriveValue} <= threshold ${PRESSURE_THRESHOLD}`,
    });
    return {
      isTheatrical: true,
      reason: `Pressure expression (${drive}) requires isolated drive > ${PRESSURE_THRESHOLD}, but was ${isolatedDriveValue} (claimed: ${driveValueAtExpression})`,
      expressionType,
      drive,
      driveValue: isolatedDriveValue,
    };
  }

  if (expressionType === 'relief' && !isAuthenticRelief) {
    vlog('theater check', {
      expressionType,
      drive,
      driveValueAtExpression,
      isolatedDriveValue,
      verdict: 'theatrical',
      reason: `isolated drive ${isolatedDriveValue} >= threshold ${RELIEF_THRESHOLD}`,
    });
    return {
      isTheatrical: true,
      reason: `Relief expression (${drive}) requires isolated drive < ${RELIEF_THRESHOLD}, but was ${isolatedDriveValue} (claimed: ${driveValueAtExpression})`,
      expressionType,
      drive,
      driveValue: isolatedDriveValue,
    };
  }

  // Expression passed directional check against the isolated drive state
  const verdict: TheaterVerdict = {
    isTheatrical: false,
    reason: `${expressionType} expression is authentic (isolated drive value: ${isolatedDriveValue})`,
    expressionType,
    drive,
    driveValue: isolatedDriveValue,
  };

  vlog('theater check', {
    expressionType,
    drive,
    driveValueAtExpression,
    isolatedDriveValue,
    verdict: 'authentic',
  });

  return verdict;
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
