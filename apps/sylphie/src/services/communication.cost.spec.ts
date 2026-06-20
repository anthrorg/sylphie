/**
 * TK-45 — Unit tests for the delivery cost computation in CommunicationService.
 *
 * Tests the pure `computeDeliveryCost` logic by exercising `estimateLlmCostUsd`
 * and `resolveLlmPricingFromEnv` directly (the same functions used by
 * CostTrackerService) against the AC requirements:
 *
 *   AC1: TYPE_2 DeepSeek cycle → costUsd === estimateLlmCostUsd(prompt, completion)
 *   AC2: TYPE_1 reflex OR Ollama-local cycle → costUsd === 0
 *
 * Run via:
 *   npx tsx apps/sylphie/src/services/communication.cost.spec.ts
 *
 * Exits non-zero on any failed assertion.
 */

import assert from 'node:assert/strict';
// Import directly from the source file to avoid pulling in the full @sylphie/shared
// barrel (which transitively imports NestJS decorators that break tsx without a
// full tsconfig with experimentalDecorators). The llm-pricing module has no deps.
import {
  estimateLlmCostUsd,
  resolveLlmPricingFromEnv,
  type LlmPricingRates,
} from '../../../../packages/shared/src/config/llm-pricing';

// ---------------------------------------------------------------------------
// Mirror of the pure helper under test.
//
// The helper lives as a module-private function in communication.service.ts
// (by design — it has no reason to be public). We replicate it here verbatim
// so we can test the logic without bootstrapping the entire NestJS module.
// Any change to the helper MUST be reflected here.
// ---------------------------------------------------------------------------

function computeDeliveryCost(
  response: {
    arbitrationType: 'TYPE_1' | 'TYPE_2' | 'SHRUG';
    tokensUsed?: { prompt: number; completion: number };
    model?: string;
  },
  rates: LlmPricingRates,
): number {
  if (
    response.arbitrationType !== 'TYPE_2' ||
    !response.tokensUsed ||
    !response.model?.toLowerCase().includes('deepseek')
  ) {
    return 0;
  }
  return estimateLlmCostUsd(
    response.tokensUsed.prompt,
    response.tokensUsed.completion,
    rates,
  );
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// Force known pricing so assertions have deterministic expected values.
// $1 per 1M input tokens, $2 per 1M output tokens.
process.env.DEEPSEEK_INPUT_PRICE_PER_M = '1';
process.env.DEEPSEEK_OUTPUT_PRICE_PER_M = '2';

const rates = resolveLlmPricingFromEnv();

console.log('TK-45: delivery cost computation');

// ---------------------------------------------------------------------------
// AC1 — TYPE_2 DeepSeek cycle → real cost
// ---------------------------------------------------------------------------

check('AC1: TYPE_2 + DeepSeek model returns estimateLlmCostUsd(promptTokens, completionTokens)', () => {
  const promptTokens = 1_000;
  const completionTokens = 500;
  const expected = estimateLlmCostUsd(promptTokens, completionTokens, rates);

  const cost = computeDeliveryCost(
    {
      arbitrationType: 'TYPE_2',
      tokensUsed: { prompt: promptTokens, completion: completionTokens },
      model: 'deepseek-chat',
    },
    rates,
  );

  assert.equal(cost, expected, `expected $${expected}, got $${cost}`);
  assert.ok(cost > 0, 'DeepSeek TYPE_2 cost must be > 0');
});

check('AC1: cost equals (prompt/1M)*inputRate + (completion/1M)*outputRate exactly', () => {
  const prompt = 2_000_000; // 2M prompt tokens
  const completion = 1_000_000; // 1M completion tokens
  // At $1/M in, $2/M out: cost = 2*1 + 1*2 = $4.000000
  const expected = 4.0;

  const cost = computeDeliveryCost(
    {
      arbitrationType: 'TYPE_2',
      tokensUsed: { prompt, completion },
      model: 'deepseek-chat',
    },
    rates,
  );

  assert.equal(cost, expected, `expected $${expected}, got $${cost}`);
});

check('AC1: model string matching is case-insensitive (DeepSeek-Chat)', () => {
  const cost = computeDeliveryCost(
    {
      arbitrationType: 'TYPE_2',
      tokensUsed: { prompt: 100, completion: 50 },
      model: 'DeepSeek-Chat',
    },
    rates,
  );

  const expected = estimateLlmCostUsd(100, 50, rates);
  assert.equal(cost, expected);
  assert.ok(cost > 0);
});

check('AC1: same rates as CostTrackerService (resolveLlmPricingFromEnv, no new table)', () => {
  // Verify rates come from the shared resolver, not a hardcoded constant.
  // If the env vars are set to known values the result must match exactly.
  const rates2 = resolveLlmPricingFromEnv();
  assert.equal(rates2.inputPricePerM, 1, 'input rate from env');
  assert.equal(rates2.outputPricePerM, 2, 'output rate from env');
  assert.equal(rates2.usedDefault, false, 'must use configured rates, not defaults');
});

// ---------------------------------------------------------------------------
// AC2 — TYPE_1 reflex → costUsd === 0
// ---------------------------------------------------------------------------

check('AC2: TYPE_1 cycle → cost is always 0', () => {
  const cost = computeDeliveryCost(
    {
      arbitrationType: 'TYPE_1',
      tokensUsed: { prompt: 1000, completion: 500 }, // token data irrelevant for TYPE_1
      model: 'deepseek-chat',
    },
    rates,
  );
  assert.equal(cost, 0, 'TYPE_1 must return 0');
});

// ---------------------------------------------------------------------------
// AC2 — Ollama-local TYPE_2 cycle → costUsd === 0
// ---------------------------------------------------------------------------

check('AC2: TYPE_2 Ollama-local cycle (model does not contain "deepseek") → cost is 0', () => {
  const cost = computeDeliveryCost(
    {
      arbitrationType: 'TYPE_2',
      tokensUsed: { prompt: 5000, completion: 2000 },
      model: 'llama3.1:8b',
    },
    rates,
  );
  assert.equal(cost, 0, 'Ollama-local TYPE_2 must return 0');
});

check('AC2: SHRUG arbitration → cost is 0', () => {
  const cost = computeDeliveryCost(
    {
      arbitrationType: 'SHRUG',
      tokensUsed: undefined,
      model: undefined,
    },
    rates,
  );
  assert.equal(cost, 0);
});

check('AC2: TYPE_2 without tokensUsed (defensive edge case) → cost is 0', () => {
  const cost = computeDeliveryCost(
    {
      arbitrationType: 'TYPE_2',
      tokensUsed: undefined,
      model: 'deepseek-chat',
    },
    rates,
  );
  assert.equal(cost, 0, 'missing tokensUsed must return 0');
});

check('AC2: TYPE_2 without model (defensive edge case) → cost is 0', () => {
  const cost = computeDeliveryCost(
    {
      arbitrationType: 'TYPE_2',
      tokensUsed: { prompt: 100, completion: 50 },
      model: undefined,
    },
    rates,
  );
  assert.equal(cost, 0, 'missing model must return 0 (cannot confirm DeepSeek)');
});

// ---------------------------------------------------------------------------
// Shared utility sanity check
// ---------------------------------------------------------------------------

check('estimateLlmCostUsd handles 0 tokens gracefully (returns 0)', () => {
  const cost = estimateLlmCostUsd(0, 0, rates);
  assert.equal(cost, 0);
});

check('estimateLlmCostUsd handles NaN/negative tokens defensively (returns 0)', () => {
  assert.equal(estimateLlmCostUsd(NaN, 500, rates), estimateLlmCostUsd(0, 500, rates));
  assert.equal(estimateLlmCostUsd(-100, 500, rates), estimateLlmCostUsd(0, 500, rates));
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\nTK-45 delivery cost: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
