/**
 * Reinforcement blocking: zero-reinforce theatrical outputs.
 *
 * CANON Standard 1 (Theater Prohibition): If an emotional expression does not
 * correlate with actual drive state (is theatrical), the action receives zero
 * reinforcement regardless of guardian feedback or outcome quality.
 *
 * This module filters drive effects to block reinforcement for theatrical
 * expressions while allowing normal contingencies for authentic ones.
 */

import type { DriveName } from '../../shared/types/drive.types';
import type { ActionOutcomePayload } from '../../shared/types/ipc.types';
import type { TheaterVerdict } from './theater-prohibition';

/**
 * Filtering result indicating whether effects should be applied.
 *
 * shouldApplyEffects: true if the action should receive normal reinforcement
 * blockedEffects: the effects that were zeroed out
 * reason: explanation of why effects were blocked (if applicable)
 */
export interface ReinforcementFilterResult {
  readonly shouldApplyEffects: boolean;
  readonly filteredEffects: Partial<Record<DriveName, number>>;
  readonly blockedEffects: Partial<Record<DriveName, number>>;
  readonly reason: string;
}

/**
 * Filter drive effects for theatrical actions.
 *
 * If the action is theatrical (emotional expression without corresponding drive),
 * all drive effects are zeroed out. The outcome is recorded but produces no
 * drive change.
 *
 * If the action is authentic, effects pass through unchanged.
 *
 * @param outcome - The ActionOutcomePayload being processed
 * @param verdict - TheaterVerdict indicating whether expression was theatrical
 * @returns ReinforcementFilterResult with filtered effects
 */
export function filterEffectsForTheater(
  outcome: ActionOutcomePayload,
  verdict: TheaterVerdict,
): ReinforcementFilterResult {
  // If expression is not theatrical, apply effects normally
  if (!verdict.isTheatrical) {
    return {
      shouldApplyEffects: true,
      filteredEffects: outcome.driveEffects,
      blockedEffects: {},
      reason: `Expression is authentic: ${verdict.reason}`,
    };
  }

  // Expression is theatrical: zero out all drive effects
  const blockedEffects = { ...outcome.driveEffects };
  const filteredEffects: Partial<Record<DriveName, number>> = {};

  return {
    shouldApplyEffects: false,
    filteredEffects,
    blockedEffects,
    reason: `Theater prohibited: ${verdict.reason} (action: ${outcome.actionType}, drive: ${verdict.drive})`,
  };
}

/**
 * Log a theater prohibition event.
 *
 * Records what action was blocked, why, and what the drive state was.
 * Used for debugging and analyzing behavioral patterns.
 *
 * @param outcome - The ActionOutcomePayload that was blocked
 * @param verdict - TheaterVerdict explaining the prohibition
 * @param blockedEffects - The effects that were zeroed out
 * @returns A formatted log message
 */
export function logTheaterProhibition(
  outcome: ActionOutcomePayload,
  verdict: TheaterVerdict,
  blockedEffects: Partial<Record<DriveName, number>>,
): string {
  const effectsStr = Object.entries(blockedEffects)
    .map(([drive, value]) => `${drive}: ${value}`)
    .join(', ');

  return (
    `[Theater Prohibited] Action: ${outcome.actionType}, ` +
    `Expression: ${verdict.expressionType}, ` +
    `Drive: ${verdict.drive}, ` +
    `DriveValue: ${verdict.driveValue}, ` +
    `BlockedEffects: [${effectsStr}], ` +
    `Reason: ${verdict.reason}`
  );
}
