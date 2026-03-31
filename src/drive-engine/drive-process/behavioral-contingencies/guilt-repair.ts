/**
 * Guilt Repair Contingency
 *
 * CANON §A.14 Behavioral Contingency — Guilt Repair:
 * Guilt is relieved through two mechanisms: acknowledgment and behavioral change.
 *
 * Relief schedule:
 *   - Acknowledgment only: guilt -= 0.10
 *   - Behavioral change only: guilt -= 0.15
 *   - Both: guilt -= 0.30
 *
 * Acknowledgment is inferred from action type containing "apologize", "acknowledge", etc.
 * Behavioral change is detected by comparing action type to previous error context.
 *
 * In-memory state tracks recent errors to detect behavioral change.
 */

import { DriveName } from '../../../shared/types/drive.types';

interface ErrorContext {
  actionType: string;
  context: string;
  timestamp: number;
}

interface GuiltyRepairing {
  consecutiveSuccesses: number;
  lastSuccessfulActionType: string | null;
}

/**
 * GuiltyRepair: Manages guilt reduction through acknowledgment and behavioral change.
 */
export class GuiltyRepair {
  // Track recent errors to detect behavioral change
  private recentErrors: ErrorContext[] = [];
  // Max number of errors to track (window size)
  private readonly MAX_ERROR_HISTORY = 10;
  // Error history timeout in milliseconds (15 minutes)
  private readonly ERROR_HISTORY_TIMEOUT_MS = 15 * 60 * 1000;

  /**
   * Compute guilt relief based on acknowledgment and behavioral change.
   *
   * @param actionType - The action being taken (check for "apologize", "acknowledge", etc.)
   * @param outcome - 'positive' or 'negative'
   * @param context - Optional context info { previousErrorActionType, previousErrorContext }
   * @returns Relief amount (guilt delta, negative values mean relief)
   */
  public computeGuiltRelief(
    actionType: string,
    outcome: string,
    context?: { previousErrorActionType?: string; previousErrorContext?: string },
  ): number {
    // Only process positive outcomes (successful repairs)
    if (outcome !== 'positive') {
      // On negative outcomes, record the error for future tracking
      if (outcome === 'negative') {
        this.recordError(actionType, context?.previousErrorContext || actionType);
      }
      return 0;
    }

    // Outcome is 'positive' — check for acknowledgment and behavioral change
    const hasAcknowledgment = this.detectAcknowledgment(actionType);
    const hasBehavioralChange = this.detectBehavioralChange(
      actionType,
      context?.previousErrorActionType,
    );

    // Relief schedule
    let relief = 0;
    if (hasAcknowledgment && hasBehavioralChange) {
      relief = -0.3; // Both: guilt -= 0.30
    } else if (hasAcknowledgment) {
      relief = -0.1; // Acknowledgment only: guilt -= 0.10
    } else if (hasBehavioralChange) {
      relief = -0.15; // Behavioral change only: guilt -= 0.15
    }

    // On successful repair, clear related errors from history
    if (relief < 0) {
      this.clearErrorsForActionType(actionType);
    }

    return relief;
  }

  /**
   * Detect acknowledgment by checking action type for keywords.
   */
  private detectAcknowledgment(actionType: string): boolean {
    const acknowledgmentKeywords = [
      'apologize',
      'acknowledge',
      'accept',
      'responsibility',
      'admit',
      'regret',
      'sorry',
    ];
    const normalized = actionType.toLowerCase();
    return acknowledgmentKeywords.some((kw) => normalized.includes(kw));
  }

  /**
   * Detect behavioral change by comparing current action to previous error.
   */
  private detectBehavioralChange(
    currentActionType: string,
    previousErrorActionType?: string,
  ): boolean {
    if (!previousErrorActionType) {
      return false;
    }
    // Different action type = behavioral change
    return currentActionType !== previousErrorActionType;
  }

  /**
   * Record an error in the error history.
   */
  private recordError(actionType: string, context: string): void {
    const now = Date.now();

    // Remove old errors (older than timeout)
    this.recentErrors = this.recentErrors.filter(
      (err) => now - err.timestamp < this.ERROR_HISTORY_TIMEOUT_MS,
    );

    // Add new error
    this.recentErrors.push({
      actionType,
      context,
      timestamp: now,
    });

    // Keep history bounded
    if (this.recentErrors.length > this.MAX_ERROR_HISTORY) {
      this.recentErrors = this.recentErrors.slice(-this.MAX_ERROR_HISTORY);
    }
  }

  /**
   * Clear errors related to a specific action type from history.
   */
  private clearErrorsForActionType(actionType: string): void {
    this.recentErrors = this.recentErrors.filter((err) => err.actionType !== actionType);
  }

  /**
   * Reset all error tracking state.
   * Called at session start or during debugging.
   */
  public reset(): void {
    this.recentErrors = [];
  }

  /**
   * Get recent error history for testing/diagnostics.
   */
  public getRecentErrors(): ErrorContext[] {
    return [...this.recentErrors];
  }
}

/**
 * Drive effect from guilt repair.
 * Always targets the Guilt drive.
 */
export interface GuiltRepairEffect {
  drive: DriveName.Guilt;
  delta: number;
}

/**
 * Singleton instance for the drive process.
 */
let instance: GuiltyRepair | null = null;

export function getOrCreateGuiltyRepair(): GuiltyRepair {
  if (!instance) {
    instance = new GuiltyRepair();
  }
  return instance;
}
