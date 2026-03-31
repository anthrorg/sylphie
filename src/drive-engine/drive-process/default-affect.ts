/**
 * Default affect fallback when no rules match.
 *
 * CANON §Subsystem 4 (Drive Engine), step 3 fallback.
 *
 * If no custom rules match an incoming event, the Drive Engine applies
 * default affects to ensure baseline behavioral responses. These defaults
 * provide sensible contingencies for common outcome types while custom rules
 * are being developed.
 */

import { DriveName } from '../../shared/types/drive.types';
import {
  DEFAULT_AFFECTS,
  OUTCOME_TYPE_TO_DEFAULT_AFFECT,
} from '../constants/rules';

/**
 * Get the default affect for an incoming event type.
 *
 * If the event type has a defined default affect, returns the effect map.
 * Otherwise returns an empty map (no default response).
 *
 * @param eventType - The incoming event type (e.g., 'action_success')
 * @returns Partial map of drive effects, or empty object if no default
 */
export function getDefaultAffect(
  eventType: string,
): Partial<Record<DriveName, number>> {
  const affectKey = OUTCOME_TYPE_TO_DEFAULT_AFFECT[eventType];

  if (!affectKey) {
    return {}; // No default affect for this event type
  }

  const affect = DEFAULT_AFFECTS[affectKey];
  return affect || {};
}

/**
 * Apply default affect to drive state.
 *
 * Used as a fallback when rule matching returns no matches.
 * Modifies the drive effects map in place.
 *
 * @param eventType - The incoming event type
 * @param driveEffects - Map to accumulate effects into (modified in place)
 * @returns The modified drive effects map
 */
export function applyDefaultAffect(
  eventType: string,
  driveEffects: Partial<Record<DriveName, number>>,
): Partial<Record<DriveName, number>> {
  const defaultEffect = getDefaultAffect(eventType);

  for (const [drive, delta] of Object.entries(defaultEffect)) {
    const driveName = drive as DriveName;
    driveEffects[driveName] = (driveEffects[driveName] || 0) + delta;
  }

  return driveEffects;
}
