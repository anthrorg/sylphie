/**
 * Contingency Coordinator
 *
 * CANON §A.14 Behavioral Contingencies:
 * Orchestrates all five behavioral contingencies. Called from DriveEngine
 * with each action outcome. Returns aggregated drive effects that are
 * applied to the current drive state.
 *
 * The five contingencies:
 * 1. Satisfaction Habituation — diminishing returns on repeated success
 * 2. Anxiety Amplification — stress amplifies failure impact
 * 3. Guilt Repair — relief through acknowledgment and behavioral change
 * 4. Social Comment Quality — relief for prompt guardian responses
 * 5. Curiosity Information Gain — relief proportional to new learning
 *
 * All contingencies are Type 1 (reflexive, no blocking calls).
 */

import {
  DriveName,
  type PressureVector,
  verboseFor,
} from '@sylphie/shared';

const vlog = verboseFor('DriveEngine');
import { type ActionOutcomePayload } from '@sylphie/shared';
import { getOrCreateSatisfactionHabituation } from './satisfaction-habituation';
import { getOrCreateAnxietyAmplification } from './anxiety-amplification';
import { getOrCreateGuiltyRepair } from './guilt-repair';
import { getOrCreateSocialCommentQuality } from './social-comment-quality';
import { getOrCreateCuriosityInformationGain } from './curiosity-information-gain';

/**
 * ContingencyCoordinator: Applies all five behavioral contingencies to outcomes.
 */
export class ContingencyCoordinator {
  private satisfactionHabituation = getOrCreateSatisfactionHabituation();
  private anxietyAmplification = getOrCreateAnxietyAmplification();
  private guiltyRepair = getOrCreateGuiltyRepair();
  private socialCommentQuality = getOrCreateSocialCommentQuality();
  private curiosityInformationGain = getOrCreateCuriosityInformationGain();

  /**
   * Apply all behavioral contingencies to an outcome.
   *
   * Called from DriveEngine.applyOutcome() after theater check passes.
   * Returns aggregated drive effects from all five contingencies.
   *
   * @param outcome - The ACTION_OUTCOME payload
   * @param currentDrives - Current drive state (read-only for context)
   * @returns Partial map of drive deltas from all contingencies
   */
  public applyContingencies(
    outcome: ActionOutcomePayload,
    currentDrives: PressureVector,
  ): Partial<Record<DriveName, number>> {
    const deltas: Partial<Record<DriveName, number>> = {};

    // Helper to accumulate a delta onto the map
    const addDelta = (drive: DriveName, value: number): void => {
      if (value !== 0) {
        deltas[drive] = (deltas[drive] || 0) + value;
      }
    };

    const firedContingencies: string[] = [];

    // 1. Satisfaction Habituation
    const satisfactionRelief = this.satisfactionHabituation.computeRelief(
      outcome.actionType,
      outcome.outcome,
    );
    if (satisfactionRelief !== 0) {
      addDelta(DriveName.Satisfaction, satisfactionRelief);
      firedContingencies.push('satisfaction-habituation');
    }

    // 2. Anxiety Amplification — drive-level effects
    // When anxiety is high at execution:
    //   - Negative outcome: amplify all positive (pressure-increasing) drive effects by 1.5x
    //   - Positive outcome: provide anxiety relief (-0.10)
    // The separate amplifyReduction() method is still available for WKG confidence reductions.
    const anxietyEffects = this.anxietyAmplification.computeDriveEffects(
      outcome.anxietyAtExecution,
      outcome.outcome,
      outcome.driveEffects,
    );
    for (const [drive, value] of Object.entries(anxietyEffects)) {
      if (value !== undefined) {
        addDelta(drive as DriveName, value);
      }
    }
    if (Object.keys(anxietyEffects).length > 0) {
      firedContingencies.push('anxiety-amplification');
    }

    // 3. Guilt Repair
    const guiltRelief = this.guiltyRepair.computeGuiltRelief(
      outcome.actionType,
      outcome.outcome,
      {
        previousErrorActionType: outcome.actionType,
        previousErrorContext: outcome.actionType,
      },
    );
    if (guiltRelief !== 0) {
      addDelta(DriveName.Guilt, guiltRelief);
      firedContingencies.push('guilt-repair');
    }

    // 4. Social Comment Quality — fire on social comment action types
    // When the outcome carries a socialCommentTimestamp, this was a
    // Sylphie-initiated social comment. Evaluate whether the guardian
    // responded promptly.
    // The standalone processGuardianResponse() path remains available
    // as an additional trigger for explicit guardian feedback on comments.
    if (outcome.socialCommentTimestamp != null) {
      const socialResult = this.socialCommentQuality.evaluateFromOutcome(
        outcome.socialCommentTimestamp,
        outcome.actionId,
        outcome.outcome,
      );
      if (socialResult.socialRelief !== 0) {
        addDelta(DriveName.Social, socialResult.socialRelief);
      }
      if (socialResult.satisfactionBonus !== 0) {
        addDelta(DriveName.Satisfaction, socialResult.satisfactionBonus);
      }
      if (socialResult.socialRelief !== 0 || socialResult.satisfactionBonus !== 0) {
        firedContingencies.push('social-comment-quality');
      }
    }

    // 5. Curiosity Information Gain — consume informationGainMetrics
    // Degrades gracefully: if informationGainMetrics is absent, returns 0.
    const curiosityRelief = this.curiosityInformationGain.computeReliefFromMetrics(
      outcome.informationGainMetrics,
    );
    if (curiosityRelief !== 0) {
      addDelta(DriveName.Curiosity, curiosityRelief);
      firedContingencies.push('curiosity-information-gain');
    }

    if (firedContingencies.length > 0) {
      vlog('contingencies fired', {
        actionType: outcome.actionType,
        fired: firedContingencies,
        deltas,
      });
    }

    return deltas;
  }

  /**
   * Record a Sylphie-initiated comment for social contingency tracking.
   *
   * @param timestamp - Wall-clock time of the comment
   * @param commentId - Optional unique identifier
   */
  public recordComment(timestamp: number, commentId?: string): void {
    this.socialCommentQuality.recordComment(timestamp, commentId);
  }

  /**
   * Process a guardian response for social contingency.
   * Returns drive deltas from social comment quality relief.
   *
   * @param responseTimestamp - Wall-clock time of the response
   * @returns Partial map of drive deltas from social contingency
   */
  public processGuardianResponse(
    responseTimestamp: number,
  ): Partial<Record<DriveName, number>> {
    const deltas: Partial<Record<DriveName, number>> = {};

    const result = this.socialCommentQuality.processGuardianResponse(responseTimestamp);

    if (result.socialRelief !== 0) {
      deltas[DriveName.Social] = (deltas[DriveName.Social] || 0) + result.socialRelief;
    }

    if (result.satisfactionBonus !== 0) {
      deltas[DriveName.Satisfaction] =
        (deltas[DriveName.Satisfaction] || 0) + result.satisfactionBonus;
    }

    return deltas;
  }

  /**
   * Get anxiety amplification factor for confidence reduction.
   *
   * Used by the WKG procedure confidence update logic to amplify
   * confidence reductions when anxiety is high at execution.
   *
   * @param anxietyAtExecution - Anxiety level at time of action
   * @param outcome - 'positive' or 'negative'
   * @param baseReduction - Base confidence reduction amount
   * @returns Amplified reduction amount
   */
  public getAmplifiedConfidenceReduction(
    anxietyAtExecution: number,
    outcome: string,
    baseReduction: number,
  ): number {
    return this.anxietyAmplification.amplifyReduction(
      anxietyAtExecution,
      outcome,
      baseReduction,
    );
  }

  /**
   * Reset all contingency state.
   * Called at session start or during debugging.
   */
  public reset(): void {
    this.satisfactionHabituation.reset();
    this.guiltyRepair.reset();
    this.socialCommentQuality.reset();
  }
}

/**
 * Singleton instance for the drive process.
 */
let instance: ContingencyCoordinator | null = null;

export function getOrCreateContingencyCoordinator(): ContingencyCoordinator {
  if (!instance) {
    instance = new ContingencyCoordinator();
  }
  return instance;
}
