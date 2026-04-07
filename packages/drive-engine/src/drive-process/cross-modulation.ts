/**
 * Drive-to-drive cross-modulation effects.
 *
 * CANON §A.15: Inter-drive dynamics that produce behavioral complexity
 * from simple per-drive rules.
 *
 * Applied after individual drive updates but before clamping.
 * These effects model how emotional states interact: high anxiety suppresses
 * curiosity, satisfaction reduces boredom, etc.
 */

import { DriveName } from '@sylphie/shared';
import {
  ANXIETY_CURIOSITY_SUPPRESSION_THRESHOLD,
  ANXIETY_CURIOSITY_SUPPRESSION_COEFFICIENT,
  SATISFACTION_BOREDOM_SUPPRESSION_THRESHOLD,
  SATISFACTION_BOREDOM_SUPPRESSION_COEFFICIENT,
  ANXIETY_INTEGRITY_AMPLIFICATION_THRESHOLD,
  ANXIETY_INTEGRITY_AMPLIFICATION_COEFFICIENT,
  SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_THRESHOLD,
  SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_COEFFICIENT,
  BOREDOM_CURIOSITY_AMPLIFICATION_THRESHOLD,
  BOREDOM_CURIOSITY_AMPLIFICATION_COEFFICIENT,
  GUILT_SATISFACTION_SUPPRESSION_THRESHOLD,
  GUILT_SATISFACTION_SUPPRESSION_COEFFICIENT,
} from '../constants/drives';

/**
 * Apply cross-modulation effects to the drive state.
 *
 * Effects are applied in order:
 * 1. High anxiety suppresses curiosity
 * 2. High satisfaction reduces boredom
 * 3. High anxiety increases integrity
 * 4. Low systemHealth amplifies anxiety
 * 5. High boredom increases curiosity
 * 6. High guilt reduces satisfaction
 *
 * All effects are multiplicative or additive as appropriate.
 * The state is not clamped here — clamping happens after all
 * cross-modulation is complete.
 *
 * @param state - Mutable drive state to modify in-place
 */
export function applyCrossModulation(state: Record<DriveName, number>): void {
  const s = state; // alias for brevity

  // 1. (Removed) Anxiety→Curiosity suppression was semantically wrong.
  //    Boredom→Curiosity amplification (rule 5) is the correct driver.

  // 2. High satisfaction reduces boredom
  if (s[DriveName.Satisfaction] > SATISFACTION_BOREDOM_SUPPRESSION_THRESHOLD) {
    s[DriveName.Boredom] *=
      1 - SATISFACTION_BOREDOM_SUPPRESSION_COEFFICIENT * s[DriveName.Satisfaction];
  }

  // 3. High anxiety (>0.7) increases integrity pressure
  if (s[DriveName.Anxiety] > ANXIETY_INTEGRITY_AMPLIFICATION_THRESHOLD) {
    s[DriveName.Integrity] +=
      ANXIETY_INTEGRITY_AMPLIFICATION_COEFFICIENT * s[DriveName.Anxiety];
  }

  // 4. High systemHealth pressure (>0.7) amplifies anxiety
  if (s[DriveName.SystemHealth] > SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_THRESHOLD) {
    s[DriveName.Anxiety] +=
      SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_COEFFICIENT *
      (s[DriveName.SystemHealth] - SYSTEM_HEALTH_ANXIETY_AMPLIFICATION_THRESHOLD);
  }

  // 5. High boredom (>0.6) increases curiosity
  if (s[DriveName.Boredom] > BOREDOM_CURIOSITY_AMPLIFICATION_THRESHOLD) {
    s[DriveName.Curiosity] +=
      BOREDOM_CURIOSITY_AMPLIFICATION_COEFFICIENT *
      (s[DriveName.Boredom] - BOREDOM_CURIOSITY_AMPLIFICATION_THRESHOLD);
  }

  // 6. High guilt reduces satisfaction
  if (s[DriveName.Guilt] > GUILT_SATISFACTION_SUPPRESSION_THRESHOLD) {
    s[DriveName.Satisfaction] *=
      1 - GUILT_SATISFACTION_SUPPRESSION_COEFFICIENT * s[DriveName.Guilt];
  }
}
