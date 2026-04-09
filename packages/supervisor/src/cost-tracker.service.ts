/**
 * CostTrackerService — tracks daily DeepSeek API spending for the supervisor.
 *
 * Enforces the SUPERVISOR_DAILY_BUDGET_USD ceiling. When the budget is
 * exhausted, the supervisor self-disables for the rest of the day. Resets
 * at midnight UTC.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CostTrackerService {
  private readonly logger = new Logger(CostTrackerService.name);

  /** Daily budget in USD. */
  private readonly dailyBudgetUsd: number;

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
    this.currentDay = this.todayUtc();
    this.logger.log(`Cost tracker initialized (daily budget: $${this.dailyBudgetUsd})`);
  }

  /**
   * Record a supervisor API call cost.
   *
   * @returns true if the budget is still available, false if exhausted.
   */
  recordCost(inputTokens: number, outputTokens: number): boolean {
    this.maybeResetDay();

    // DeepSeek pricing: $0.28/M input, $0.42/M output (as of 2026-04)
    const cost =
      (inputTokens / 1_000_000) * 0.28 + (outputTokens / 1_000_000) * 0.42;

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

  /** Check if budget is still available without recording a cost. */
  hasBudget(): boolean {
    this.maybeResetDay();
    return this.costToday < this.dailyBudgetUsd;
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
