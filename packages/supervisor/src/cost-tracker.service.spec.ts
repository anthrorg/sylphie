/**
 * Unit tests for CostTrackerService — budget enforcement correctness.
 *
 * Run via: npx tsx packages/supervisor/src/cost-tracker.service.spec.ts
 *
 * Covers the ticket-6 correctness fixes:
 *   1. canAfford() bounds overshoot (rejects a call that would breach ceiling)
 *   2. recordCost() does NOT keep accruing after the budget is exhausted
 *   3. NaN / negative token counts contribute 0 (never poison the total)
 *   4. budgetUsedFraction() is clamped [0,1] and guards a zero budget
 *   5. estimateCost() never returns a negative / non-finite value
 */

import assert from 'node:assert/strict';
import { CostTrackerService } from './cost-tracker.service.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

// Pricing is resolved from process.env by the shared utility (single source of
// truth), NOT from ConfigService. Force a large, known rate so a handful of
// tokens crosses a small budget: $1,000,000 per 1M tokens === $1 per token.
process.env.DEEPSEEK_INPUT_PRICE_PER_M = '1000000';
process.env.DEEPSEEK_OUTPUT_PRICE_PER_M = '1000000';

/** Minimal ConfigService stub with a controllable budget. */
function makeConfig(budgetUsd: string): any {
  const map: Record<string, string> = {
    SUPERVISOR_DAILY_BUDGET_USD: budgetUsd,
  };
  return {
    get<T>(key: string, def?: T): T {
      return (map[key] as unknown as T) ?? def;
    },
  };
}

function makeTracker(budgetUsd: string): CostTrackerService {
  return new CostTrackerService(makeConfig(budgetUsd));
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok ${name}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('CostTrackerService — budget enforcement');

// 1. canAfford bounds overshoot.
check('canAfford rejects a call that would breach the ceiling', () => {
  const t = makeTracker('5.00');
  // Pricing is $1/token, so a 10-token call costs ~$10 > $5 budget.
  const est = t.estimateCost(10, 0);
  assert.ok(est > 5, `estimate should exceed budget, got ${est}`);
  assert.equal(t.canAfford(est), false);
  // A small call is affordable.
  assert.equal(t.canAfford(t.estimateCost(2, 0)), true);
});

// 2. recordCost does not keep accruing once exhausted.
check('recordCost stops accruing after exhaustion (no counter drift)', () => {
  const t = makeTracker('5.00');
  // First call pushes over the ceiling: 6 tokens => $6 >= $5.
  const remainsAfterFirst = t.recordCost(6, 0);
  assert.equal(remainsAfterFirst, false, 'first call should exhaust budget');
  const usedAfterFirst = t.budgetUsedToday();
  assert.ok(usedAfterFirst >= 5, `used should be >= budget, got ${usedAfterFirst}`);

  // Subsequent late call must be refused and must NOT inflate the counter.
  const remainsAfterSecond = t.recordCost(100, 100);
  assert.equal(remainsAfterSecond, false);
  assert.equal(
    t.budgetUsedToday(),
    usedAfterFirst,
    'counter must not drift after exhaustion',
  );
});

// 3. NaN / negative tokens contribute 0.
check('NaN / negative tokens contribute 0 to cost', () => {
  const t = makeTracker('5.00');
  assert.equal(t.estimateCost(NaN, NaN), 0);
  assert.equal(t.estimateCost(-50, -50), 0);
  // Recording garbage must not poison the running total.
  t.recordCost(NaN, -10);
  assert.equal(t.budgetUsedToday(), 0);
  assert.equal(Number.isFinite(t.budgetUsedToday()), true);
  // And the tracker is still usable afterward.
  assert.equal(t.hasBudget(), true);
});

// 4. budgetUsedFraction clamped + zero-budget guard.
check('budgetUsedFraction is clamped and guards a zero budget', () => {
  const t = makeTracker('10.00');
  assert.equal(t.budgetUsedFraction(), 0);
  t.recordCost(3, 0); // ~$3 of $10
  const frac = t.budgetUsedFraction();
  assert.ok(frac > 0 && frac <= 1, `fraction in (0,1], got ${frac}`);

  const zero = makeTracker('0');
  // Zero budget => treated as fully spent (back off), never NaN/Infinity.
  assert.equal(zero.budgetUsedFraction(), 1);
});

// 5. estimateCost is always finite and non-negative.
check('estimateCost never returns negative / non-finite', () => {
  const t = makeTracker('5.00');
  const c = t.estimateCost(3, 4);
  assert.equal(Number.isFinite(c), true);
  assert.ok(c >= 0);
});

console.log(`\nCostTrackerService: ${passed} checks passed\n`);
