/**
 * Rule effect application and DSL parsing.
 *
 * CANON §Subsystem 4 (Drive Engine), step 3: Effect execution.
 *
 * Rules are stored with an 'effect' string in a simple DSL:
 *   "integrity += 0.10" → add 0.10 to integrity
 *   "satisfaction *= 0.8" → multiply satisfaction by 0.8
 *   "anxiety = 0.5" → set anxiety to 0.5
 *   "guilt -= 0.05" → subtract 0.05 from guilt
 *
 * Multiple rules can match one event; all applicable effects are accumulated
 * and applied once per tick.
 */

import { DriveName } from '@sylphie/shared';

/**
 * Parsed effect rule, ready for execution.
 */
export interface ParsedEffect {
  driveName: DriveName;
  operator: '+=' | '-=' | '*=' | '=';
  value: number;
}

/**
 * Parse an effect string into a structured ParsedEffect.
 *
 * Examples:
 *   "integrity += 0.10" → { driveName: 'integrity', operator: '+=', value: 0.10 }
 *   "satisfaction *= 0.8" → { driveName: 'satisfaction', operator: '*=', value: 0.8 }
 *   "anxiety = 0.5" → { driveName: 'anxiety', operator: '=', value: 0.5 }
 *
 * @param effectStr - The effect string from the database
 * @returns Parsed effect, or null if the effect string is invalid
 */
export function parseEffect(effectStr: string): ParsedEffect | null {
  try {
    const trimmed = effectStr.trim();

    // Pattern: driveName OPERATOR value
    const pattern = /^(\w+)\s*(=|\+=|-=|\*=)\s*([-+]?[\d.]+)$/;
    const match = trimmed.match(pattern);

    if (!match) {
      return null;
    }

    const [, driveName, operator, valueStr] = match;
    const drive = driveName as DriveName;

    // Validate that this is a real drive name
    if (!Object.values(DriveName).includes(drive)) {
      return null;
    }

    const value = parseFloat(valueStr);
    if (isNaN(value)) {
      return null;
    }

    return {
      driveName: drive,
      operator: operator as '+=' | '-=' | '*=' | '=',
      value,
    };
  } catch (_err) {
    return null;
  }
}

/**
 * Apply multiple effects to a drive state accumulator.
 *
 * Effects are applied in order, accumulating changes. Multiplicative effects
 * are tracked separately from additive effects to allow proper composition.
 *
 * @param currentDriveState - Map of drive values to modify (modified in place)
 * @param effects - Parsed effects to apply
 * @returns The modified drive state (same object passed in)
 */
export function applyEffects(
  currentDriveState: Partial<Record<DriveName, number>>,
  effects: ParsedEffect[],
): Partial<Record<DriveName, number>> {
  const multiplicativeEffects: Partial<Record<DriveName, number>> = {};

  for (const effect of effects) {
    switch (effect.operator) {
      case '+=':
        currentDriveState[effect.driveName] =
          (currentDriveState[effect.driveName] || 0) + effect.value;
        break;

      case '-=':
        currentDriveState[effect.driveName] =
          (currentDriveState[effect.driveName] || 0) - effect.value;
        break;

      case '*=':
        // For multiplicative effects, we need the base value from somewhere.
        // We'll apply these after additive effects.
        multiplicativeEffects[effect.driveName] = effect.value;
        break;

      case '=':
        // Assignment replaces the current value
        currentDriveState[effect.driveName] = effect.value;
        break;
    }
  }

  // Apply multiplicative effects
  for (const [drive, multiplier] of Object.entries(multiplicativeEffects)) {
    const driveName = drive as DriveName;
    currentDriveState[driveName] = (currentDriveState[driveName] || 0) * multiplier;
  }

  return currentDriveState;
}

/**
 * Accumulate effects from multiple matched rules.
 *
 * When multiple rules match, their effects are combined. Additive effects
 * are summed; multiplicative effects are composed.
 *
 * @param ruleEffects - Array of effect strings from matched rules
 * @returns Accumulated drive effects as a partial map
 */
export function accumulateRuleEffects(
  ruleEffects: string[],
): Partial<Record<DriveName, number>> {
  const accumulated: Partial<Record<DriveName, number>> = {};
  const parsedEffects: ParsedEffect[] = [];

  for (const effectStr of ruleEffects) {
    const parsed = parseEffect(effectStr);
    if (parsed) {
      parsedEffects.push(parsed);
    }
  }

  return applyEffects(accumulated, parsedEffects);
}
