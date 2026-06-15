/**
 * Unit tests for NarrationBuilderService — behavioral baseline (ticket 4).
 *
 * Run via: npx tsx packages/supervisor/src/narration-builder.service.spec.ts
 *
 * Covers:
 *   1. The first narration carries a sampleCount=0 baseline (no prior history;
 *      the current cycle is judged against an empty reference, not itself).
 *   2. After several cycles the baseline reflects the prior window: arbitration
 *      mix, mean pressure, frequent actions, mean latency.
 *   3. The baseline window is bounded (does not grow unbounded).
 */

import assert from 'node:assert/strict';
import { NarrationBuilderService } from './narration-builder.service.js';
import { INITIAL_DRIVE_STATE } from '@sylphie/shared';
import type { CycleResponse } from '@sylphie/shared';

function makeCycle(
  arbitrationType: 'TYPE_1' | 'TYPE_2' | 'SHRUG',
  actionId: string,
  latencyMs: number,
  totalPressure = 0,
): CycleResponse {
  return {
    turnId: `t-${Math.random().toString(36).slice(2)}`,
    text: 'x',
    arbitrationType,
    actionId,
    driveSnapshot: {
      pressureVector: { ...INITIAL_DRIVE_STATE },
      timestamp: new Date(),
      tickNumber: 1,
      driveDeltas: {} as any,
      ruleMatchResult: { ruleId: null, eventType: 'TEST', matched: false },
      totalPressure,
      sessionId: 's1',
    },
    arbitrationResult: { type: arbitrationType } as any,
    latencyMs,
    knowledgeGrounding: 'GROUNDED' as any,
  } as CycleResponse;
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok ${name}`);
}

console.log('NarrationBuilderService — behavioral baseline');

// 1. First narration → empty baseline.
check('first narration carries a sampleCount=0 baseline', () => {
  const b = new NarrationBuilderService();
  const n = b.buildNarration(makeCycle('TYPE_1', 'a', 10));
  assert.ok(n.behavioralBaseline, 'baseline must be present in narration');
  assert.equal(n.behavioralBaseline!.sampleCount, 0);
  assert.deepEqual(n.behavioralBaseline!.frequentActions, []);
});

// 2. Baseline reflects prior cycles.
check('baseline reflects the prior-cycle window', () => {
  const b = new NarrationBuilderService();
  // Prior history: 2× TYPE_1 'a', 1× TYPE_2 'b'.
  b.buildNarration(makeCycle('TYPE_1', 'a', 10, 0.2));
  b.buildNarration(makeCycle('TYPE_1', 'a', 20, 0.4));
  b.buildNarration(makeCycle('TYPE_2', 'b', 30, 0.6));
  // The 4th narration sees the baseline of the prior 3.
  const n = b.buildNarration(makeCycle('SHRUG', 'c', 40, 0.8));
  const base = n.behavioralBaseline!;

  assert.equal(base.sampleCount, 3);
  // Mix: 2/3 TYPE_1, 1/3 TYPE_2, 0 SHRUG.
  assert.ok(Math.abs(base.arbitrationMix.TYPE_1 - 2 / 3) < 1e-9);
  assert.ok(Math.abs(base.arbitrationMix.TYPE_2 - 1 / 3) < 1e-9);
  assert.equal(base.arbitrationMix.SHRUG, 0);
  // Mean total pressure: (0.2+0.4+0.6)/3 = 0.4.
  assert.ok(Math.abs(base.meanTotalPressure - 0.4) < 1e-9);
  // Mean latency: (10+20+30)/3 = 20.
  assert.ok(Math.abs(base.meanLatencyMs - 20) < 1e-9);
  // Frequent actions: 'a' (2) ahead of 'b' (1).
  assert.equal(base.frequentActions[0].action, 'a');
  assert.equal(base.frequentActions[0].count, 2);
});

// 3. Bounded window.
check('baseline window stays bounded under many cycles', () => {
  const b = new NarrationBuilderService();
  let n: any;
  for (let i = 0; i < 200; i++) {
    n = b.buildNarration(makeCycle('TYPE_1', 'a', 10, 0.1));
  }
  // Window cap is 50 — sampleCount must never exceed it.
  assert.ok(n.behavioralBaseline.sampleCount <= 50);
});

console.log(`\nNarrationBuilderService: ${passed} checks passed\n`);
