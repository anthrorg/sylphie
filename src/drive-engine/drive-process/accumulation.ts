/**
 * Drive accumulation and decay computation.
 *
 * CANON §A.14: Per-drive rates for pressure buildup and relief.
 *
 * Accumulation: drives increase toward 1.0 as unmet needs build.
 * Decay: satisfied drives fade as the relief fades away.
 */

import { DriveName } from '../../shared/types/drive.types';
import {
  DRIVE_ACCUMULATION_RATES,
  DRIVE_DECAY_RATES,
} from '../constants/drives';

/**
 * Combined rates (accumulation + decay) for each drive per tick.
 *
 * For most drives: either positive (accumulating toward 1.0) or zero.
 * For satisfaction/sadness: negative (decaying toward 0.0).
 *
 * Values are applied directly to the drive each tick:
 * drive += rate
 *
 * After clamping, the drive is bounded to [-10.0, 1.0].
 */
export function getDriveUpdateRates(): Record<DriveName, number> {
  const rates: Record<DriveName, number> = {} as Record<DriveName, number>;

  for (const drive of Object.values(DriveName)) {
    const accumulation = DRIVE_ACCUMULATION_RATES[drive] ?? 0;
    const decay = DRIVE_DECAY_RATES[drive] ?? 0;
    rates[drive] = accumulation + decay;
  }

  return rates;
}

/**
 * Validate that accumulation and decay rates are consistent with design intent.
 *
 * Accumulation rates should be non-negative.
 * Decay rates should be non-positive.
 * No drive should have both significant accumulation and decay (that's a design error).
 *
 * Called at Drive Engine startup to catch misconfiguration early.
 */
export function validateRates(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const drive of Object.values(DriveName)) {
    const acc = DRIVE_ACCUMULATION_RATES[drive];
    const dec = DRIVE_DECAY_RATES[drive];

    if (acc < 0) {
      errors.push(`${drive} has negative accumulation rate: ${acc}`);
    }
    if (dec > 0) {
      errors.push(`${drive} has positive decay rate: ${dec}`);
    }
    if (acc > 0 && dec < 0) {
      errors.push(
        `${drive} has both positive accumulation (${acc}) and negative decay (${dec}) — likely a tuning error`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
