/**
 * Unit tests for NarrationBuilderService.
 *
 * Run via: npx tsx packages/supervisor/src/narration-builder.service.spec.ts
 *
 * Covers:
 *   1. The first narration carries a sampleCount=0 baseline (no prior history;
 *      the current cycle is judged against an empty reference, not itself).
 *   2. After several cycles the baseline reflects the prior window: arbitration
 *      mix, mean pressure, frequent actions, mean latency.
 *   3. The baseline window is bounded (does not grow unbounded).
 *   4. (TK-74 AC1) Valid sidecar model state populates convergenceScore,
 *      globalModelConfidence, and panelDivergenceScores correctly.
 *   5. (TK-74 AC2) Null sidecar model state leaves all three fields undefined
 *      with no exception thrown.
 */

import assert from 'node:assert/strict';
import { NarrationBuilderService } from './narration-builder.service.js';
import { INITIAL_DRIVE_STATE } from '@sylphie/shared';
import type { CycleResponse } from '@sylphie/shared';
import type { SidecarModelState } from './sidecar-control.service.js';

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

/** Minimal SidecarControlService stub that returns a scripted model state. */
function makeSidecarStub(state: SidecarModelState | null): any {
  return { getModelState: async () => state };
}

function makeModelState(training_loss: number | null): SidecarModelState {
  return {
    total_parameters: 10000,
    training_active: true,
    training_steps: 100,
    training_loss,
    bootstrap_mode: 'full',
    models: {
      global: { params: 1000 },
      panels: {
        alpha: { params: 200 },
        beta: { params: 300 },
      },
      convergence: { params: 500 },
      deliberation: {
        pragmatist: { params: 100 },
        conservative: { params: 100 },
        advocate: { params: 100 },
        synthesis: { params: 100 },
      },
    },
  };
}

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok ${name}`);
}

async function run(): Promise<void> {
  console.log('NarrationBuilderService — behavioral baseline + sidecar enrichment (TK-74)');

  // ── Behavioral baseline (pre-existing tests, now async) ──────────────────

  // 1. First narration → empty baseline.
  await check('first narration carries a sampleCount=0 baseline', async () => {
    const b = new NarrationBuilderService();
    const n = await b.buildNarration(makeCycle('TYPE_1', 'a', 10));
    assert.ok(n.behavioralBaseline, 'baseline must be present in narration');
    assert.equal(n.behavioralBaseline!.sampleCount, 0);
    assert.deepEqual(n.behavioralBaseline!.frequentActions, []);
  });

  // 2. Baseline reflects prior cycles.
  await check('baseline reflects the prior-cycle window', async () => {
    const b = new NarrationBuilderService();
    // Prior history: 2× TYPE_1 'a', 1× TYPE_2 'b'.
    await b.buildNarration(makeCycle('TYPE_1', 'a', 10, 0.2));
    await b.buildNarration(makeCycle('TYPE_1', 'a', 20, 0.4));
    await b.buildNarration(makeCycle('TYPE_2', 'b', 30, 0.6));
    // The 4th narration sees the baseline of the prior 3.
    const n = await b.buildNarration(makeCycle('SHRUG', 'c', 40, 0.8));
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
  await check('baseline window stays bounded under many cycles', async () => {
    const b = new NarrationBuilderService();
    let n: any;
    for (let i = 0; i < 200; i++) {
      n = await b.buildNarration(makeCycle('TYPE_1', 'a', 10, 0.1));
    }
    // Window cap is 50 — sampleCount must never exceed it.
    assert.ok(n.behavioralBaseline.sampleCount <= 50);
  });

  // ── TK-74 AC1: valid model state → all three fields populated ────────────

  // AC1: training_loss=0.2 → convergenceScore = 1/(1+0.2) = 5/6 ≈ 0.8333...
  await check('AC1: valid sidecar state populates convergenceScore, globalModelConfidence, panelDivergenceScores', async () => {
    const stub = makeSidecarStub(makeModelState(0.2));
    const b = new NarrationBuilderService(stub);
    const n = await b.buildNarration(makeCycle('TYPE_1', 'a', 10));

    const expectedScore = 1 / (1 + 0.2);
    assert.ok(
      typeof n.convergenceScore === 'number',
      'convergenceScore must be a number',
    );
    assert.ok(
      Math.abs(n.convergenceScore! - expectedScore) < 1e-9,
      `convergenceScore expected ${expectedScore}, got ${n.convergenceScore}`,
    );
    assert.ok(
      typeof n.globalModelConfidence === 'number',
      'globalModelConfidence must be a number',
    );
    assert.ok(
      Math.abs(n.globalModelConfidence! - expectedScore) < 1e-9,
      `globalModelConfidence expected ${expectedScore}, got ${n.globalModelConfidence}`,
    );
    assert.ok(
      n.panelDivergenceScores !== null && n.panelDivergenceScores !== undefined,
      'panelDivergenceScores must not be null/undefined',
    );
    // Panel divergence scores: alpha=200/1000=0.2, beta=300/1000=0.3
    assert.ok(Math.abs(n.panelDivergenceScores!['alpha']! - 0.2) < 1e-9, 'alpha panel score');
    assert.ok(Math.abs(n.panelDivergenceScores!['beta']! - 0.3) < 1e-9, 'beta panel score');
  });

  // AC1: training_loss=null → score should be undefined but other fields still populated
  await check('AC1: null training_loss yields undefined scores but non-null panelDivergenceScores', async () => {
    const stub = makeSidecarStub(makeModelState(null));
    const b = new NarrationBuilderService(stub);
    const n = await b.buildNarration(makeCycle('TYPE_1', 'a', 10));

    assert.equal(n.convergenceScore, undefined, 'convergenceScore undefined when loss is null');
    assert.equal(n.globalModelConfidence, undefined, 'globalModelConfidence undefined when loss is null');
    // panelDivergenceScores still populated from panels data
    assert.ok(
      n.panelDivergenceScores !== null && n.panelDivergenceScores !== undefined,
      'panelDivergenceScores still present even when training_loss is null',
    );
  });

  // ── TK-74 AC2: sidecar returns null → all three fields undefined, no throw ─

  await check('AC2: sidecar returns null → all three fields undefined, no exception', async () => {
    const stub = makeSidecarStub(null);
    const b = new NarrationBuilderService(stub);

    let n: any;
    // Must not throw
    try {
      n = await b.buildNarration(makeCycle('TYPE_1', 'a', 10));
    } catch (err) {
      assert.fail(`buildNarration must not throw when sidecar is down: ${err}`);
    }

    assert.equal(n.convergenceScore, undefined, 'convergenceScore undefined when sidecar is down');
    assert.equal(n.globalModelConfidence, undefined, 'globalModelConfidence undefined when sidecar is down');
    assert.equal(n.panelDivergenceScores, undefined, 'panelDivergenceScores undefined when sidecar is down');
  });

  // AC2: no sidecar injected (undefined/null) → all three fields undefined
  await check('AC2: no sidecar injected → all three fields undefined, no exception', async () => {
    // Plain construction without DI — sidecarControl defaults to null
    const b = new NarrationBuilderService();
    const n = await b.buildNarration(makeCycle('TYPE_1', 'a', 10));

    assert.equal(n.convergenceScore, undefined);
    assert.equal(n.globalModelConfidence, undefined);
    assert.equal(n.panelDivergenceScores, undefined);
  });
}

run()
  .then(() => {
    console.log(`\nNarrationBuilderService: ${passed} checks passed\n`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
