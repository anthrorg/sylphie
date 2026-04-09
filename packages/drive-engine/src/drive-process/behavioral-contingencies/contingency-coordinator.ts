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

    // 1. Satisfaction Habituation
    const satisfactionRelief = this.satisfactionHabituation.computeRelief(
      outcome.actionType,
      outcome.outcome,
    );
    if (satisfactionRelief !== 0) {
      deltas[DriveName.Satisfaction] =
        (deltas[DriveName.Satisfaction] || 0) + satisfactionRelief;
    }

    // 2. Anxiety Amplification
    // This is applied to confidence reductions in the WKG, not directly to drives.
    // For now, we note it but don't apply directly to drive deltas.
    // (WKG procedure confidence updates happen elsewhere in the pipeline)

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
      deltas[DriveName.Guilt] = (deltas[DriveName.Guilt] || 0) + guiltRelief;
    }

    // 4. Social Comment Quality
    // This is triggered by guardian responses, not outcomes.
    // Will be called separately via processGuardianResponse().

    // 5. Curiosity Information Gain
    const curiosityRelief = this.curiosityInformationGain.computeReliefFromContext(
      outcome as unknown as Record<string, unknown>,
    );
    if (curiosityRelief !== 0) {
      deltas[DriveName.Curiosity] = (deltas[DriveName.Curiosity] || 0) + curiosityRelief;
    }

    const firedContingencies: string[] = [];
    if (satisfactionRelief !== 0) firedContingencies.push('satisfaction-habituation');
    if (guiltRelief !== 0) firedContingencies.push('guilt-repair');
    if (curiosityRelief !== 0) firedContingencies.push('curiosity-information-gain');

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
