/**
 * Unit tests for simulation scoring pure helpers (TK-64).
 *
 * Tests computeConfidence and computeRisk from simulation.service.ts.
 * Run via: npx tsx packages/planning/src/pipeline/simulation-scoring.spec.ts
 *
 * Covers all acceptance criteria:
 *   AC1: count=1 successRate=1 → confidence < 0.2
 *        count=50 successRate=1 → confidence > 0.7
 *        count=0 → confidence=0, risk=1.0
 *   AC2: effects [-0.9,+0.3,-0.3] high-variance → risk > 0.5
 *        effects [-0.3,-0.3,-0.3] low-variance  → risk < 0.3
 */

import assert from 'node:assert/strict';
import { computeConfidence, computeRisk } from './simulation.service.js';

// ---------------------------------------------------------------------------
// Test runner (same pattern as other planning specs)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function describe(suiteName: string, fn: () => void): void {
  console.log(`\n  ${suiteName}`);
  fn();
}

function it(testName: string, fn: () => void): void {
  try {
    fn();
    console.log(`    PASS  ${testName}`);
    passed++;
  } catch (err) {
    console.error(`    FAIL  ${testName}`);
    console.error(`          ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// AC1 — computeConfidence: shrinkage-prior, sample-size-aware
// ---------------------------------------------------------------------------

describe('computeConfidence — shrinkage prior (k=10)', () => {
  it('count=0 → confidence exactly 0 (no observations → zero confidence)', () => {
    assert.equal(computeConfidence(0, 0), 0);
  });

  it('count=1, successRate=1 → confidence < 0.2 (one lucky win ≠ high confidence)', () => {
    const c = computeConfidence(1, 1);
    // With k=10: 1/(1+10) ≈ 0.0909
    assert.ok(c < 0.2, `Expected confidence < 0.2, got ${c}`);
  });

  it('count=50, successRate=1 → confidence > 0.7 (50 consistent wins → high confidence)', () => {
    const c = computeConfidence(50, 50);
    // With k=10: 50/(50+10) ≈ 0.833
    assert.ok(c > 0.7, `Expected confidence > 0.7, got ${c}`);
  });

  it('count=1, successRate=0 → confidence=0', () => {
    const c = computeConfidence(0, 1);
    assert.equal(c, 0);
  });

  it('count=10, successRate=0.5 → confidence = 5/20 = 0.25', () => {
    const c = computeConfidence(5, 10);
    assert.ok(Math.abs(c - 0.25) < 1e-9, `Expected 0.25, got ${c}`);
  });

  it('custom k: count=1, successRate=1, k=0 → confidence = 1.0 (no shrinkage)', () => {
    const c = computeConfidence(1, 1, 0);
    assert.equal(c, 1.0);
  });

  it('shrinkage is monotonically increasing with count (all-success sequences)', () => {
    // More observations → higher confidence, never exceeds 1
    let prev = 0;
    for (const n of [1, 5, 10, 20, 50, 100]) {
      const c = computeConfidence(n, n);
      assert.ok(c > prev, `Expected confidence to grow with count; at n=${n} got ${c}, prev=${prev}`);
      assert.ok(c <= 1.0);
      prev = c;
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — computeRisk: variance-aware, effect-based
// ---------------------------------------------------------------------------

describe('computeRisk — variance-aware', () => {
  it('empty effects (count=0 case) → risk=1.0', () => {
    assert.equal(computeRisk([]), 1.0);
  });

  it('high-variance effects [-0.9,+0.3,-0.3] → risk > 0.5', () => {
    const r = computeRisk([-0.9, 0.3, -0.3]);
    // badRate=1/3, stdDev≈0.49 → risk≈0.82
    assert.ok(r > 0.5, `Expected risk > 0.5, got ${r}`);
  });

  it('low-variance effects [-0.3,-0.3,-0.3] → risk < 0.3', () => {
    const r = computeRisk([-0.3, -0.3, -0.3]);
    // badRate=0, stdDev=0 → risk=0
    assert.ok(r < 0.3, `Expected risk < 0.3, got ${r}`);
  });

  it('all positive effects (all bad) → high risk', () => {
    const r = computeRisk([0.5, 0.3, 0.4]);
    assert.ok(r > 0.5, `Expected high risk for all-positive effects, got ${r}`);
  });

  it('single negative effect → low risk', () => {
    const r = computeRisk([-0.5]);
    // badRate=0, stdDev=0 → risk=0
    assert.equal(r, 0);
  });

  it('risk is capped at 1.0 even for extreme variance', () => {
    // Very large range: badRate could push over 1 before clamping
    const r = computeRisk([-10, 10, -10, 10]);
    assert.ok(r <= 1.0, `Expected risk ≤ 1.0, got ${r}`);
  });

  it('weighted: low-variance with count=50 per value → same as unweighted', () => {
    // weights=[50,50,50] for [-0.3,-0.3,-0.3] is identical to unweighted
    const r = computeRisk([-0.3, -0.3, -0.3], [50, 50, 50]);
    assert.ok(r < 0.3, `Expected risk < 0.3 with weights, got ${r}`);
  });

  it('weighted: high-variance with large counts → risk > 0.5', () => {
    // Each distinct effect observed many times — same risk shape as unweighted
    const r = computeRisk([-0.9, 0.3, -0.3], [20, 10, 20]);
    assert.ok(r > 0.5, `Expected risk > 0.5 with weights, got ${r}`);
  });
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.exit(1);
}
