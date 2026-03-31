/**
 * PlanningRateLimiterService — enforces per-window and concurrent plan limits.
 *
 * Implements IPlanningRateLimiter to enforce two concurrent caps that prevent
 * the Planning Runaway attractor:
 *   1. Per-window plan creation cap (e.g., 3 plans per 1-hour window).
 *   2. Active-plans cap (maximum procedure nodes in the WKG not yet evaluated).
 *
 * CANON §Known Attractor States — Planning Runaway: Both caps are required
 * defenses. A per-window cap alone does not prevent unbounded accumulation
 * of unevaluated procedures across windows. The active-plans cap closes that gap.
 *
 * Implementation:
 * - Tracks plansCreatedInWindow and activePlanCount in memory.
 * - Resets the window counter when the window duration expires.
 * - Reports state via RateLimiterState for dashboard display.
 *
 * Provided under the PLANNING_RATE_LIMITER token by PlanningModule.
 * Internal — not exported from the module barrel.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig, PlanningConfig } from '../../shared/config/app.config';
import type {
  IPlanningRateLimiter,
  RateLimiterState,
} from '../interfaces/planning.interfaces';

@Injectable()
export class PlanningRateLimiterService implements IPlanningRateLimiter {
  private planningConfig: PlanningConfig;

  /**
   * Number of plans created in the current time window.
   */
  private plansCreatedInWindow: number = 0;

  /**
   * Number of active plans (created but not yet evaluated).
   */
  private activePlanCount: number = 0;

  /**
   * Wall-clock time when the current window started.
   */
  private windowStartTime: Date = new Date();

  /**
   * Total tokens used in the current window (for tracking, not blocking).
   */
  private totalTokensUsedInWindow: number = 0;

  constructor(private readonly configService: ConfigService<AppConfig>) {
    const config = this.configService.get('app')?.planning;
    if (!config) {
      throw new Error('Planning configuration is missing from AppConfig');
    }
    this.planningConfig = config;
  }

  /**
   * Check whether the planning pipeline may proceed with a new plan.
   *
   * Returns false if either:
   * - The per-window plan creation cap has been reached.
   * - The active-plans cap has been reached.
   *
   * First checks if the current window has expired and resets if so.
   *
   * @returns True if the pipeline may proceed; false if rate-limited.
   */
  canProceed(): boolean {
    this.refreshWindow();

    return (
      this.plansCreatedInWindow < this.planningConfig.maxPlansPerWindow &&
      this.activePlanCount < this.planningConfig.maxActivePlans
    );
  }

  /**
   * Record that a new plan was successfully created and committed to the WKG.
   *
   * Increments both the per-window plan counter and the active-plans counter.
   * Must be called by PlanningService immediately after successful procedure creation.
   */
  recordPlanCreated(): void {
    this.plansCreatedInWindow++;
    this.activePlanCount++;
  }

  /**
   * Record that an active plan was evaluated by Decision Making.
   *
   * Decrements the active-plans counter (minimum 0). This prevents the
   * active-plans cap from being permanently saturated after a batch of
   * plan creations.
   *
   * Called by PlanningService when it receives a PREDICTION_EVALUATED event
   * referencing a Planning-created procedure.
   */
  recordPlanEvaluated(): void {
    this.activePlanCount = Math.max(0, this.activePlanCount - 1);
  }

  /**
   * Return the current rate limiter state for dashboard display and diagnostics.
   *
   * @returns Snapshot of the current RateLimiterState.
   */
  getState(): RateLimiterState {
    this.refreshWindow();

    const windowResetsAt = new Date(
      this.windowStartTime.getTime() + this.planningConfig.windowDurationMs,
    );

    return {
      plansThisWindow: this.plansCreatedInWindow,
      activePlans: this.activePlanCount,
      windowResetsAt,
      canProceed: this.canProceed(),
    };
  }

  /**
   * Check if the current window has expired and reset if so.
   *
   * Called by canProceed() and getState() to maintain window consistency.
   * If the window has expired, resets plansCreatedInWindow to 0 and advances
   * windowStartTime.
   *
   * @private
   */
  private refreshWindow(): void {
    const now = new Date();
    const windowEndTime = new Date(
      this.windowStartTime.getTime() + this.planningConfig.windowDurationMs,
    );

    if (now >= windowEndTime) {
      // Window has expired; reset counters
      this.plansCreatedInWindow = 0;
      this.totalTokensUsedInWindow = 0;
      this.windowStartTime = now;
    }
  }
}
