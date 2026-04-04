/**
 * Opportunity decay mechanism.
 *
 * CANON §Known Attractor States (Opportunity Runaway prevention):
 * Opportunities expire when the underlying prediction improves. As MAE
 * decreases below the threshold, opportunity priority decays and eventually
 * the opportunity is removed entirely.
 */

import type { PredictionEvaluator } from './prediction-evaluator';
import {
  DECAY_MAE_THRESHOLD,
  DECAY_PRIORITY_REDUCTION,
  DECAY_REMOVAL_CONSECUTIVE_THRESHOLD,
} from '../constants/opportunity-detection';
import type { Opportunity } from './opportunity';

/**
 * Apply decay to a set of opportunities based on current prediction accuracy.
 *
 * For each opportunity:
 *   1. Check current MAE for its predictionType
 *   2. If MAE < DECAY_MAE_THRESHOLD: increment consecutiveGoodPredictions
 *   3. If consecutiveGoodPredictions >= threshold: mark for removal
 *   4. After first good prediction: reduce priority by 50%
 *
 * @param opportunities - Array of opportunities to apply decay to
 * @param evaluator - PredictionEvaluator to check current MAE
 * @returns Array of opportunities to keep (removes those ready for deletion)
 */
export function applyDecay(
  opportunities: Opportunity[],
  evaluator: PredictionEvaluator,
): Opportunity[] {
  const toKeep: Opportunity[] = [];

  for (const opp of opportunities) {
    const maeResult = evaluator.getMAE(opp.predictionType);

    if (maeResult.mae < DECAY_MAE_THRESHOLD) {
      // Prediction has improved
      opp.consecutiveGoodPredictions++;

      // First time we see improvement: reduce priority
      if (opp.consecutiveGoodPredictions === 1) {
        opp.priority *= DECAY_PRIORITY_REDUCTION;
        opp.updatedAt = new Date();
      }

      // After sufficient consecutive good predictions: remove entirely
      if (opp.consecutiveGoodPredictions >= DECAY_REMOVAL_CONSECUTIVE_THRESHOLD) {
        // Don't add to toKeep — opportunity is removed
        continue;
      }
    } else {
      // Prediction accuracy has degraded again: reset counter
      opp.consecutiveGoodPredictions = 0;
    }

    toKeep.push(opp);
  }

  return toKeep;
}
