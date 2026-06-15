/**
 * Unit tests for AdaptiveSamplerService — deterministic, bounded sampling.
 *
 * Run via: npx tsx packages/supervisor/src/adaptive-sampler.service.spec.ts
 *
 * Covers:
 *   1. adaptive=false → effective rate == base rate (legacy behavior)
 *   2. effective rate is always within [adaptiveMinRate, adaptiveMaxRate]
 *   3. high budget pressure STRETCHES the interval (samples less)
 *   4. high novelty SHRINKS the interval (samples more)
 *   5. determinism: same history → same output
 */

import assert from 'node:assert/strict';
import { AdaptiveSamplerService } from './adaptive-sampler.service.js';
import type { SamplingPolicy } from './interfaces/supervisor.types.js';

function policy(over: Partial<SamplingPolicy> = {}): SamplingPolicy {
  return {
    sampleRate: 10,
    alwaysEvaluate: ['guardian_feedback', 'attractor_alert'],
    burstMode: false,
    dailyBudgetUsd: 5,
    adaptive: true,
    adaptiveMinRate: 2,
    adaptiveMaxRate: 60,
    ...over,
  };
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok ${name}`);
}

console.log('AdaptiveSamplerService');

// 1. adaptive=false → base rate.
check('adaptive=false returns the base sample rate unchanged', () => {
  const s = new AdaptiveSamplerService();
  const r = s.nextEffectiveRate(policy({ adaptive: false }), {
    budgetUsedFraction: 0.9,
    arbitrationType: 'TYPE_2',
    nowMs: 1000,
  });
  assert.equal(r, 10);
});

// 2. always bounded.
check('effective rate stays within [min,max] under extreme inputs', () => {
  const s = new AdaptiveSamplerService();
  // Extreme stretch: full budget + heavy load, all Type-1 (no novelty).
  let t = 0;
  let r = 10;
  for (let i = 0; i < 30; i++) {
    t += 1; // 1ms apart => very high cps
    r = s.nextEffectiveRate(policy(), {
      budgetUsedFraction: 1,
      arbitrationType: 'TYPE_1',
      nowMs: t,
    });
  }
  assert.ok(r >= 2 && r <= 60, `bounded, got ${r}`);
});

// 3. budget pressure stretches the interval.
check('high budget pressure stretches the interval (>= low pressure)', () => {
  const low = new AdaptiveSamplerService();
  const high = new AdaptiveSamplerService();
  // Identical arbitration/load history; differ only in budget pressure.
  let rLow = 0;
  let rHigh = 0;
  for (let i = 0; i < 20; i++) {
    rLow = low.nextEffectiveRate(policy(), {
      budgetUsedFraction: 0.0,
      arbitrationType: 'TYPE_1',
      nowMs: i * 1000,
    });
    rHigh = high.nextEffectiveRate(policy(), {
      budgetUsedFraction: 0.95,
      arbitrationType: 'TYPE_1',
      nowMs: i * 1000,
    });
  }
  assert.ok(rHigh > rLow, `high-pressure ${rHigh} should exceed low ${rLow}`);
});

// 4. novelty shrinks the interval.
check('high novelty shrinks the interval (<= no-novelty)', () => {
  const novel = new AdaptiveSamplerService();
  const calm = new AdaptiveSamplerService();
  let rNovel = 0;
  let rCalm = 0;
  for (let i = 0; i < 20; i++) {
    rNovel = novel.nextEffectiveRate(policy(), {
      budgetUsedFraction: 0.2,
      arbitrationType: 'TYPE_2', // novel
      nowMs: i * 1000,
    });
    rCalm = calm.nextEffectiveRate(policy(), {
      budgetUsedFraction: 0.2,
      arbitrationType: 'TYPE_1', // routine
      nowMs: i * 1000,
    });
  }
  assert.ok(rNovel < rCalm, `novel ${rNovel} should be < calm ${rCalm}`);
});

// 5. determinism.
check('same history produces identical output', () => {
  const a = new AdaptiveSamplerService();
  const b = new AdaptiveSamplerService();
  const inputs = Array.from({ length: 15 }, (_, i) => ({
    budgetUsedFraction: (i % 5) / 5,
    arbitrationType: (i % 2 === 0 ? 'TYPE_1' : 'TYPE_2') as 'TYPE_1' | 'TYPE_2',
    nowMs: i * 500,
  }));
  const ra = inputs.map((x) => a.nextEffectiveRate(policy(), x));
  const rb = inputs.map((x) => b.nextEffectiveRate(policy(), x));
  assert.deepEqual(ra, rb);
});

console.log(`\nAdaptiveSamplerService: ${passed} checks passed\n`);
