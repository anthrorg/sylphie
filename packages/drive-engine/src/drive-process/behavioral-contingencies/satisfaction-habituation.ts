/**
 * Satisfaction Habituation Contingency
 *
 * CANON §A.14 Behavioral Contingency — Satisfaction Habituation:
 * Tracks consecutive successes on the same action type. Diminishing returns
 * on repeated success create a natural drift toward exploration.
 *
 * Curve: 1st=+0.20, 2nd=+0.15, 3rd=+0.10, 4th=+0.05, 5th+=+0.02
 *
 * Counter resets when a different action type succeeds.
 * In-memory Map tracks per-action-type success counts.
 *
 * This is a Type 1 computation — no blocking calls, pure in-memory state.
 */

import { DriveName, verboseFor } from '@sylphie/shared';

const vlog = verboseFor('DriveEngine');

interface SatisfactionHabitationState {
  consecutiveSuccesses: number;
  lastSuccessfulActionType: string | null;
}

/**
 * SatisfactionHabituation: Manages habituation curve for repeated success.
 */
export class SatisfactionHabituation {
  // Per-action-type state: tracks consecutive successes
  private actionTypeHistory: Map<string, SatisfactionHabitationState> = new Map();

  /**
   * Compute satisfaction relief based on success streak for an action type.
   *
   * @param actionType - The action category (e.g., "exploration", "social_interaction")
   * @param outcome - 'positive' for success, 'negative' for failure
   * @returns Relief amount (0 if not a success, or habituation value if success)
   */
  public computeRelief(
    actionType: string,
    outcome: 'positive' | 'negative',
  ): number {
    if (outcome === 'negative') {
      // Failure resets the counter
      this.actionTypeHistory.delete(actionType);
      return 0;
    }

    // Outcome is 'positive' — a success
    const state = this.actionTypeHistory.get(actionType) || {
      consecutiveSuccesses: 0,
      lastSuccessfulActionType: actionType,
    };

    // Increment consecutive successes for this action type
    state.consecutiveSuccesses += 1;
    this.actionTypeHistory.set(actionType, state);

    // Habituation curve: diminishing returns
    const relief = this.habituationCurve(state.consecutiveSuccesses);

    vlog('satisfaction habituation', {
      actionType,
      consecutiveSuccesses: state.consecutiveSuccesses,
      relief,
    });

    return relief;
  }

  /**
   * Habituation curve: successive successes produce diminishing relief.
   *
   * @param successCount - Number of consecutive successes (1-indexed)
   * @returns Relief amount in [0.02, 0.20]
   */
  private habituationCurve(successCount: number): number {
    if (successCount === 1) return 0.2;
    if (successCount === 2) return 0.15;
    if (successCount === 3) return 0.1;
    if (successCount === 4) return 0.05;
    // 5th and beyond
    return 0.02;
  }

  /**
   * Reset all habituation state.
   * Called at session start or during debugging.
   */
  public reset(): void {
    this.actionTypeHistory.clear();
  }

  /**
   * Get the current habituation state for an action type.
   * Exported for testing and diagnostics.
   */
  public getState(actionType: string): SatisfactionHabitationState | undefined {
    return this.actionTypeHistory.get(actionType);
  }
}

/**
 * Drive effect from satisfaction habituation.
 * Always targets the Satisfaction drive.
 */
export interface SatisfactionHabitationEffect {
  drive: DriveName.Satisfaction;
  delta: number;
}

/**
 * Singleton instance for the drive process.
 */
let instance: SatisfactionHabituation | null = null;

export function getOrCreateSatisfactionHabituation(): SatisfactionHabituation {
  if (!instance) {
    instance = new SatisfactionHabituation();
  }
  return instance;
}
