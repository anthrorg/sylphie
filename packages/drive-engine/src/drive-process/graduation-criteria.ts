/**
 * Type 1/Type 2 graduation and demotion logic.
 *
 * CANON §Type 1/Type 2 Discipline:
 * - Type 1: Graph-based reflexes. Fast, pre-computed, no LLM cost.
 * - Type 2: LLM-deliberative. Accurate but expensive in compute and latency.
 *
 * Graduation (Type 2 → Type 1) requires:
 *   confidence > 0.80 (sufficient experience)
 *   AND MAE < 0.10 (predictions are reliable)
 *
 * Demotion (Type 1 → Type 2) occurs if:
 *   MAE > 0.15 (accuracy degraded, environment/model has shifted)
 *
 * The Drive Engine uses these criteria to make autonomous promotion/demotion
 * decisions. The decision-making subsystem acts on them.
 */

import { verboseFor } from '@sylphie/shared';

const vlog = verboseFor('DriveEngine');

import {
  GRADUATION_CONFIDENCE_THRESHOLD,
  GRADUATION_MAE_THRESHOLD,
  DEMOTION_MAE_THRESHOLD,
} from '../constants/prediction-evaluation';

/**
 * Result of a graduation check.
 */
export interface GraduationCheckResult {
  canGraduate: boolean;
  reason: string;
}

/**
 * Result of a demotion check.
 */
export interface DemotionCheckResult {
  shouldDemote: boolean;
  reason: string;
}

/**
 * Evaluate whether a Type 2 behavior can graduate to Type 1.
 *
 * Requirements (both must be true):
 * 1. confidence > 0.80 — sufficient experience with the behavior
 * 2. MAE < 0.10 — predictions about outcomes are accurate
 *
 * @param actionType - The behavior being evaluated
 * @param confidence - Confidence score from the WKG [0.0, 1.0]
 * @param mae - Current mean absolute error for this action type
 * @returns Graduation decision with reason
 */
export function checkGraduation(
  actionType: string,
  confidence: number,
  mae: number,
): GraduationCheckResult {
  // Check confidence threshold
  if (confidence <= GRADUATION_CONFIDENCE_THRESHOLD) {
    return {
      canGraduate: false,
      reason: `Confidence ${confidence.toFixed(3)} <= threshold ${GRADUATION_CONFIDENCE_THRESHOLD} (need > ${GRADUATION_CONFIDENCE_THRESHOLD})`,
    };
  }

  // Check MAE threshold
  if (mae >= GRADUATION_MAE_THRESHOLD) {
    return {
      canGraduate: false,
      reason: `MAE ${mae.toFixed(4)} >= threshold ${GRADUATION_MAE_THRESHOLD} (need < ${GRADUATION_MAE_THRESHOLD})`,
    };
  }

  // Both criteria met
  vlog('graduation check: PASS', {
    actionType,
    confidence: +confidence.toFixed(3),
    mae: +mae.toFixed(4),
  });

  return {
    canGraduate: true,
    reason: `Ready for Type 1 graduation: confidence ${confidence.toFixed(3)} > ${GRADUATION_CONFIDENCE_THRESHOLD}, MAE ${mae.toFixed(4)} < ${GRADUATION_MAE_THRESHOLD}`,
  };
}

/**
 * Evaluate whether a Type 1 behavior should be demoted back to Type 2.
 *
 * Demotion occurs when prediction accuracy degrades:
 * - MAE > 0.15 (was ACCURATE or MODERATE, now degraded)
 *
 * This indicates the learned reflex no longer accurately predicts outcomes,
 * so it's safer to revert to LLM deliberation until accuracy recovers.
 *
 * @param actionType - The behavior being evaluated
 * @param currentMAE - Current mean absolute error
 * @returns Demotion decision with reason
 */
export function checkDemotion(
  actionType: string,
  currentMAE: number,
): DemotionCheckResult {
  if (currentMAE > DEMOTION_MAE_THRESHOLD) {
    vlog('demotion check: DEMOTE', {
      actionType,
      currentMAE: +currentMAE.toFixed(4),
      threshold: DEMOTION_MAE_THRESHOLD,
    });
    return {
      shouldDemote: true,
      reason: `Prediction accuracy degraded: MAE ${currentMAE.toFixed(4)} > demotion threshold ${DEMOTION_MAE_THRESHOLD}`,
    };
  }

  vlog('demotion check: KEEP', {
    actionType,
    currentMAE: +currentMAE.toFixed(4),
    threshold: DEMOTION_MAE_THRESHOLD,
  });

  return {
    shouldDemote: false,
    reason: `Prediction accuracy acceptable: MAE ${currentMAE.toFixed(4)} <= ${DEMOTION_MAE_THRESHOLD}`,
  };
}
