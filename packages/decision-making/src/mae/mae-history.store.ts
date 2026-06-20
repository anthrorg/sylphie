/**
 * MaeHistoryStore — shared rolling MAE window for all graduation/confidence consumers.
 *
 * CANON §Dual-Process Cognition: Graduation and demotion checks (confidence >
 * 0.80, MAE < 0.10 / > 0.15) must all read from the same observation window.
 * Previously, PredictionService, ConfidenceUpdaterService, and Type1TrackerService
 * each maintained independent Map<string, number[]> windows — meaning graduation
 * in one service could disagree with the other's window at any given moment.
 *
 * This store is the single source of truth. PredictionService writes via append()
 * after evaluating a prediction. ConfidenceUpdaterService and Type1TrackerService
 * read via getMean() / getWindow() during graduation and demotion checks.
 *
 * Window semantics: FIFO, capped at MAX_MAE_WINDOW = 10 entries per action ID.
 * Older observations are evicted as new ones arrive. This matches the graduation
 * requirement of "last 10 uses" from CANON §Confidence Dynamics.
 *
 * Lifecycle: in-process singleton scoped to the NestJS module. Not persisted
 * across restarts — the graduation state machine can re-earn graduation status
 * as observations accumulate in a new session.
 *
 * Injection: registered as a plain class provider (no symbol token needed — only
 * internal services inject it, all within DecisionMakingModule).
 */

import { Injectable } from '@nestjs/common';

/** Maximum number of MAE observations retained per action ID. */
export const MAX_MAE_WINDOW = 10;

@Injectable()
export class MaeHistoryStore {
  /**
   * Per-action rolling MAE window. Key = WKG procedure node ID (actionId).
   * Value = last MAX_MAE_WINDOW MAE values in insertion order (FIFO).
   */
  private readonly windows = new Map<string, number[]>();

  /**
   * Append a MAE observation for an action, evicting the oldest entry when
   * the window is at capacity.
   *
   * @param actionId - WKG procedure node ID.
   * @param mae      - Mean absolute error from PredictionEvaluation (0.0–1.0).
   */
  append(actionId: string, mae: number): void {
    let window = this.windows.get(actionId);
    if (!window) {
      window = [];
      this.windows.set(actionId, window);
    }

    if (window.length >= MAX_MAE_WINDOW) {
      window.shift();
    }
    window.push(mae);
  }

  /**
   * Return the full rolling window for an action.
   *
   * The returned array is the live internal array — treat it as read-only.
   * Returns an empty frozen array when no observations exist yet.
   *
   * @param actionId - WKG procedure node ID.
   * @returns Read-only view of the rolling MAE window.
   */
  getWindow(actionId: string): readonly number[] {
    return this.windows.get(actionId) ?? EMPTY;
  }

  /**
   * Return the arithmetic mean of the rolling window for an action.
   *
   * Returns 0.0 when no observations exist — a conservative sentinel that
   * ensures graduation checks (MAE < 0.10) pass only when real data is
   * present AND meets the threshold (since 0.0 < 0.10 is true, this is a
   * deliberate conservative default: without any history, an action will not
   * be blocked from graduating on the MAE axis alone, but the confidence
   * threshold still applies).
   *
   * @param actionId - WKG procedure node ID.
   * @returns Arithmetic mean of the window, or 0.0 if the window is empty.
   */
  getMean(actionId: string): number {
    const window = this.windows.get(actionId);
    if (!window || window.length === 0) {
      return 0.0;
    }
    return window.reduce((sum, v) => sum + v, 0) / window.length;
  }
}

/** Shared empty sentinel to avoid allocating a new array on every miss. */
const EMPTY: readonly number[] = Object.freeze([]);
