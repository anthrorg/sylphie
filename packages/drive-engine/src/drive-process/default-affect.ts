/**
 * Default affect fallback when no rules match.
 *
 * CANON §Subsystem 4 (Drive Engine), step 3 fallback.
 *
 * If no custom rules match an incoming action outcome, the Drive Engine
 * computes default effects using the action category defaults defined in
 * constants/rules.ts. Actions without any matching default are flagged
 * for rule debate (the internal process proposes a rule structure for
 * guardian review).
 */

import type { ActionOutcomePayload } from '@sylphie/shared';
import { DriveName } from '@sylphie/shared';
import { computeDefaultAffect } from '../constants/rules';

/**
 * Get the default affect for an incoming action outcome signal.
 *
 * Uses the actionType (procedure category) to look up base relief,
 * then layers outcome-level bonuses (guardian feedback).
 * Metadata-scaled signals (sensory, scene) use counts/magnitudes.
 *
 * @param payload - The ACTION_OUTCOME signal payload (no driveEffects)
 * @returns Computed drive effects map, or empty if no default exists
 */
export function getDefaultAffect(
  payload: ActionOutcomePayload,
): Partial<Record<DriveName, number>> {
  return computeDefaultAffect(payload);
}
