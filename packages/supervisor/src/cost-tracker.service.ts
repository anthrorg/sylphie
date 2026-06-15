/**
 * CostTrackerService — tracks daily DeepSeek API spending for the supervisor.
 *
 * Enforces the SUPERVISOR_DAILY_BUDGET_USD ceiling. When the budget is
 * exhausted, the supervisor self-disables for the rest of the day. Resets
 * at midnight UTC.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  estimateLlmCostUsd,
  resolveLlmPricingFromEnv,
  type LlmPricingRates,
} from '@sylphie/shared';

@Injectable()
export class CostTrackerService {
  private readonly logger = new Logger(CostTrackerService.name);

  /** Daily budget in USD. */
  private readonly dailyBudgetUsd: number;

  /**
   * DeepSeek pricing rates, resolved from the shared LLM-pricing utility so the
   * supervisor and the drive engine's cost reporting cannot drift. Same env
   * vars (DEEPSEEK_INPUT/OUTPUT_PRICE_PER_M), same documented DeepSeek defaults.
   */
  private readonly pricingRates: LlmPricingRates;

  /** Cumulative cost for today (resets at midnight UTC). */
  private costToday = 0;

  /** The UTC date string (YYYY-MM-DD) for the current tracking period. */
  private currentDay: string;

  /** Total cost across all days. */
  private totalCost = 0;

  constructor(private readonly config: ConfigService) {
    this.dailyBudgetUsd = parseFloat(
      this.config.get<string>('SUPERVISOR_DAILY_BUDGET_USD', '5.00'),
    );

    // Pricing is operator-configurable so rate changes are an env update, not a
    // code deploy. Resolved via the shared utility (single source of truth).
    this.pricingRates = resolveLlmPricingFromEnv();
    if (this.pricingRates.usedDefault) {
      this.logger.warn(
        'DeepSeek pricing env vars not fully configured — using documented ' +
          'DeepSeek defaults for cost tracking.',
      );
    }

    this.currentDay = this.todayUtc();
    this.logger.log(
      `Cost tracker initialized (daily budget: $${this.dailyBudgetUsd}, ` +
        `rates: $${this.pricingRates.inputPricePerM}/M in, ` +
        `$${this.pricingRates.outputPricePerM}/M out)`,
    );
  }

  /**
   * Estimate (but do not record) the USD cost of a call with the given token
   * counts. Sanitizes inputs so a NaN / negative / non-integer token count can
   * never corrupt the running total. Public so callers can do a pre-flight
   * affordability check before spending.
   */
  estimateCost(inputTokens: number, outputTokens: number): number {
    const inTok = sanitizeTokens(inputTokens);
    const outTok = sanitizeTokens(outputTokens);
    const cost = estimateLlmCostUsd(inTok, outTok, this.pricingRates);
    // estimateLlmCostUsd is config-driven; defend against a misconfigured
    // negative/NaN rate producing a non-finite cost that would poison the total.
    return Number.isFinite(cost) && cost > 0 ? cost : 0;
  }

  /**
   * Record a supervisor API call cost.
   *
   * Correctness contract:
   *   - Resets the daily counter first (so a day-boundary crossing is handled
   *     before any accounting).
   *   - If the budget is ALREADY exhausted, the cost is NOT accrued again — the
   *     ceiling is a hard stop, not a counter that drifts unboundedly past the
   *     limit on every late call. (Previously, every post-exhaustion call kept
   *     inflating costToday, corrupting budgetUsedToday / budgetRemaining.)
   *   - Token counts are sanitized; a NaN/negative count contributes 0, never a
   *     NaN that would make every subsequent comparison false.
   *
   * @returns true if budget remains AFTER recording, false if now exhausted or
   *          if the call was rejected because the budget was already spent.
   */
  recordCost(inputTokens: number, outputTokens: number): boolean {
    this.maybeResetDay();

    // Hard stop: once the ceiling is reached, stop accruing. The supervisor is
    // already gated by hasBudget()/canAfford() upstream, but a defensive guard
    // here prevents counter drift if a late in-flight call lands post-exhaustion.
    if (this.costToday >= this.dailyBudgetUsd) {
      this.logger.warn(
        `Budget already exhausted; refusing to accrue further cost ` +
          `($${this.costToday.toFixed(4)} / $${this.dailyBudgetUsd})`,
      );
      return false;
    }

    const cost = this.estimateCost(inputTokens, outputTokens);

    this.costToday += cost;
    this.totalCost += cost;

    if (this.costToday >= this.dailyBudgetUsd) {
      this.logger.warn(
        `Daily budget exhausted ($${this.costToday.toFixed(4)} / $${this.dailyBudgetUsd})`,
      );
      return false;
    }

    return true;
  }

  /** Check if any budget is still available without recording a cost. */
  hasBudget(): boolean {
    this.maybeResetDay();
    return this.costToday < this.dailyBudgetUsd;
  }

  /**
   * Pre-flight affordability check: would a call costing `estimatedCostUsd` stay
   * within (or exactly at) the daily ceiling?
   *
   * This is the correct gate for "should I make this call?" — `hasBudget()`
   * only answers "is there ANY budget left?", which lets a single expensive
   * call overshoot the ceiling arbitrarily. `canAfford` refuses calls whose
   * estimated cost would breach the ceiling, bounding the overshoot.
   *
   * A non-finite or negative estimate is treated as 0 (affordable) so a bad
   * estimate cannot wedge the supervisor shut.
   */
  canAfford(estimatedCostUsd: number): boolean {
    this.maybeResetDay();
    const est =
      Number.isFinite(estimatedCostUsd) && estimatedCostUsd > 0
        ? estimatedCostUsd
        : 0;
    return this.costToday + est <= this.dailyBudgetUsd;
  }

  /** Get remaining budget for today. */
  budgetRemaining(): number {
    this.maybeResetDay();
    return Math.max(0, this.dailyBudgetUsd - this.costToday);
  }

  /** Get cost spent today. */
  budgetUsedToday(): number {
    this.maybeResetDay();
    return this.costToday;
  }

  /**
   * Fraction of today's budget spent, clamped to [0, 1]. Drives the adaptive
   * sampler's budget-pressure signal. Guards a zero/negative budget (treated as
   * fully spent so the supervisor backs off rather than dividing by zero).
   */
  budgetUsedFraction(): number {
    this.maybeResetDay();
    if (!(this.dailyBudgetUsd > 0)) return 1;
    return Math.max(0, Math.min(1, this.costToday / this.dailyBudgetUsd));
  }

  /** Get total cost across all days. */
  getTotalCost(): number {
    return this.totalCost;
  }

  /** Reset daily counter if the date has changed. */
  private maybeResetDay(): void {
    const today = this.todayUtc();
    if (today !== this.currentDay) {
      this.logger.log(
        `New day: resetting budget (yesterday spent $${this.costToday.toFixed(4)})`,
      );
      this.costToday = 0;
      this.currentDay = today;
    }
  }

  private todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Coerce a token count to a safe non-negative integer. NaN / negative /
 * non-finite → 0. Prevents a malformed usage report from corrupting the
 * running cost total (a single NaN would make every budget comparison false).
 */
function sanitizeTokens(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens < 0) return 0;
  return Math.floor(tokens);
}
