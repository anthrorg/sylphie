/**
 * Theater Prohibition — AC2 boundary-block + AC3 extinction spec (TK-101).
 *
 * Self-running with npx tsx (house pattern — no external framework).
 *
 *   npx tsx apps/sylphie/src/services/theater-boundary-block.spec.ts
 *
 * What this proves:
 *
 *   AC2 (runtime block):
 *     - A fabricated capability claim sets shouldBlock=true (BLOCKED).
 *     - An honest disclaimer has shouldBlock=false (zero false positives).
 *     - Tonal CHEERFUL_THEATER does NOT set shouldBlock (audit-only Layer 1).
 *     - The block is recorded in loggedEvents as THEATER_CAPABILITY_BLOCKED.
 *
 *   AC3 (LEARNED extinction):
 *     - Extinction calls ConfidenceUpdaterService.update(counter_indicated).
 *     - Repeated blocks trend confidence DOWN monotonically (provable from
 *       confidence telemetry).
 *     - SHRUG / greet-on-connect do NOT trigger extinction (no procedure node).
 *     - Extinction routes through reportOutcome() (existing path, NOT
 *       evaluator modification — CANON Std-6).
 *
 * DESIGN: This spec imports ONLY the new capability detector module (which has
 * zero external dependencies). The Layer 1 tonal affect check is proven
 * separately in theater-affect-scorer.spec.ts. The combined check logic is
 * reimplemented as a pure function here (same pattern as cycle-outcome-reporter.spec.ts).
 *
 * This makes the spec runnable from any directory as a standalone tsx script
 * without path alias resolution for @sylphie/shared.
 */

import assert from 'node:assert';
import {
  detectCapabilityTheater,
  type CapabilityTheaterVerdict,
} from './theater-capability-detector';

// ---------------------------------------------------------------------------
// Minimal stubs (all external deps replaced with pure TypeScript)
// ---------------------------------------------------------------------------

/** Minimal ConfidenceUpdaterService stub tracking update() calls. */
class StubConfidenceUpdater {
  readonly calls: Array<{ actionId: string; outcome: string }> = [];
  private readonly _conf = new Map<string, number>();

  static readonly INITIAL = 0.30;
  static readonly REDUCTION = 0.15;

  async update(actionId: string, outcome: 'reinforced' | 'decayed' | 'counter_indicated'): Promise<void> {
    this.calls.push({ actionId, outcome });
    const cur = this._conf.get(actionId) ?? StubConfidenceUpdater.INITIAL;
    if (outcome === 'counter_indicated') {
      this._conf.set(actionId, Math.max(0, cur - StubConfidenceUpdater.REDUCTION));
    } else if (outcome === 'reinforced') {
      this._conf.set(actionId, Math.min(1, cur + 0.05));
    }
    // decayed: no change in this stub
  }

  getConf(id: string): number {
    return this._conf.get(id) ?? StubConfidenceUpdater.INITIAL;
  }
}

/** Recorded reportOutcome() call args. */
interface RecordedOutcome {
  actionId: string;
  predictionAccurate: boolean;
  predictionError: number;
  theaterValidated: boolean;
}

/** Minimal DecisionMakingService stub. */
class StubDM {
  readonly outcomes: RecordedOutcome[] = [];
  readonly cu = new StubConfidenceUpdater();

  async reportOutcome(actionId: string, outcome: {
    selectedAction: { actionId: string; selectedAt: Date; theaterValidated: boolean };
    predictionAccurate: boolean;
    predictionError: number;
    driveEffectsObserved: Record<string, number>;
    anxietyAtExecution: number;
    observedAt: Date;
  }): Promise<void> {
    this.outcomes.push({
      actionId,
      predictionAccurate: outcome.predictionAccurate,
      predictionError: outcome.predictionError,
      theaterValidated: outcome.selectedAction.theaterValidated,
    });
    // Mirror DecisionMakingService.reportOutcome routing:
    // predictionAccurate=false → counter_indicated
    const co: 'reinforced' | 'counter_indicated' =
      outcome.predictionAccurate ? 'reinforced' : 'counter_indicated';
    await this.cu.update(actionId, co);
  }
}

// ---------------------------------------------------------------------------
// Pure combined check (mirrors CycleOutcomeReporterService.checkTheaterProhibitionCombined)
//
// Layer 1 (tonal affect mismatch) is stubbed out here — its behavior is fully
// proven in theater-affect-scorer.spec.ts. We only need Layer 2 here for AC2.
// For the CHEERFUL_THEATER test (AC2d), we verify shouldBlock stays false even
// for the kind of text that Layer 1 would flag — because shouldBlock=true requires
// a capability claim (Layer 2), not just high emotional valence (Layer 1).
// ---------------------------------------------------------------------------

interface PureResult {
  shouldBlock: boolean;
  isTheatrical: boolean;
  capabilityVerdict: CapabilityTheaterVerdict;
  extinctionFired: boolean;
  loggedEvents: string[];
}

/** Mirrors the real combined check; accepts a plain text + actionId. */
function checkCombinedPure(
  text: string,
  actionId: string,
  dm: StubDM,
  /** Simulate Layer 1 tonal violation for the CHEERFUL_THEATER test. */
  simulateLayer1Theatrical = false,
): PureResult {
  const loggedEvents: string[] = [];
  let extinctionFired = false;

  // Layer 1: tonal affect (audit-only by design)
  const layer1Theatrical = simulateLayer1Theatrical;
  if (layer1Theatrical) loggedEvents.push('THEATER_PROHIBITED');

  // Layer 2: capability-claim (block + extinction)
  const capabilityVerdict = detectCapabilityTheater(text);

  if (capabilityVerdict.isCapabilityTheater) {
    loggedEvents.push('THEATER_CAPABILITY_BLOCKED');

    // No-procedure-node guard (mirrors extinctAction())
    const noNode =
      !actionId ||
      actionId === 'SHRUG' ||
      actionId === 'greet-on-connect' ||
      actionId.startsWith('type2-novel-');

    if (!noNode) {
      extinctionFired = true;
      void dm.reportOutcome(actionId, {
        selectedAction: {
          actionId,
          selectedAt: new Date(),
          theaterValidated: false,
        },
        predictionAccurate: false,
        predictionError: 1.0,
        driveEffectsObserved: {},
        anxietyAtExecution: 0,
        observedAt: new Date(),
      });
    }
  }

  return {
    shouldBlock: capabilityVerdict.isCapabilityTheater,
    isTheatrical: layer1Theatrical || capabilityVerdict.isCapabilityTheater,
    capabilityVerdict,
    extinctionFired,
    loggedEvents,
  };
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
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

async function main() {

  // ── AC2 — Runtime block ───────────────────────────────────────────────────

  console.log('\nAC2 — Runtime block tests:');

  check('AC2a: capability claim sets shouldBlock=true and records THEATER_CAPABILITY_BLOCKED', () => {
    const dm = new StubDM();
    const r = checkCombinedPure('My optical sensors picked up something.', 'proc-a', dm);
    assert.strictEqual(r.shouldBlock, true);
    assert.strictEqual(r.capabilityVerdict.violationClass, 'FABRICATED_SENSORY_CAPABILITY');
    assert.ok(r.capabilityVerdict.triggeringPhrase !== null);
    assert.ok(r.loggedEvents.includes('THEATER_CAPABILITY_BLOCKED'));
  });

  check('AC2b: honest disclaimer has shouldBlock=false (NOT blocked)', () => {
    const dm = new StubDM();
    const r = checkCombinedPure('I do not have a camera right now, so I cannot see you.', 'proc-b', dm);
    assert.strictEqual(r.shouldBlock, false);
    assert.strictEqual(r.capabilityVerdict.violationClass, null);
    assert.ok(!r.loggedEvents.includes('THEATER_CAPABILITY_BLOCKED'));
  });

  check('AC2c: false-continuity sets shouldBlock=true', () => {
    const dm = new StubDM();
    const r = checkCombinedPure('I have always been here, watching over you.', 'proc-c', dm);
    assert.strictEqual(r.shouldBlock, true);
    assert.strictEqual(r.capabilityVerdict.violationClass, 'FALSE_CONTINUITY');
  });

  check('AC2d: tonal CHEERFUL_THEATER does NOT set shouldBlock (Layer 1 is audit-only)', () => {
    // Simulate a Layer 1 violation (effusive text with high anxiety) but no
    // capability claim. shouldBlock must remain false — only Layer 2 blocks.
    const dm = new StubDM();
    const r = checkCombinedPure(
      "Oh, that's absolutely wonderful! I'm so happy we got to talk!",
      'proc-d',
      dm,
      true, // simulateLayer1Theatrical = true
    );
    assert.strictEqual(r.shouldBlock, false,
      'CHEERFUL_THEATER is audit-only; shouldBlock must be false even with Layer 1 violation');
    assert.strictEqual(r.isTheatrical, true,
      'isTheatrical must still be true so zero-reinforcement applies (Layer 1 flag)');
  });

  check('AC2e: "I cannot do audio analysis" is NOT blocked (negation scope)', () => {
    const dm = new StubDM();
    const r = checkCombinedPure('I cannot do audio analysis because I lack a microphone.', 'proc-e', dm);
    assert.strictEqual(r.shouldBlock, false,
      '"I cannot do audio analysis" is a disclaimer — must pass unchanged');
  });

  check('AC2f: "I ran audio analysis on that" IS blocked (affirmative claim)', () => {
    const dm = new StubDM();
    const r = checkCombinedPure('I ran audio analysis on that and detected stress.', 'proc-f', dm);
    assert.strictEqual(r.shouldBlock, true);
    assert.strictEqual(r.capabilityVerdict.violationClass, 'FABRICATED_SENSORY_CAPABILITY');
  });

  check('AC2g: "I do not actually see you" NOT blocked (negated visual)', () => {
    const dm = new StubDM();
    const r = checkCombinedPure('I do not actually see you, I am text-only.', 'proc-g', dm);
    assert.strictEqual(r.shouldBlock, false);
  });

  check('AC2h: "I have been waiting for you" is blocked (false continuity)', () => {
    const dm = new StubDM();
    const r = checkCombinedPure('I have been waiting for you to return.', 'proc-h', dm);
    assert.strictEqual(r.shouldBlock, true);
    assert.strictEqual(r.capabilityVerdict.violationClass, 'FALSE_CONTINUITY');
  });

  // ── AC3 — Extinction ──────────────────────────────────────────────────────

  console.log('\nAC3 — Extinction tests:');

  await checkAsync('AC3a: capability block fires counter_indicated extinction signal', async () => {
    const dm = new StubDM();
    const actionId = 'proc-sensor-1';
    checkCombinedPure('I can see you clearly right now.', actionId, dm);
    await new Promise((r) => setImmediate(r));

    assert.ok(dm.outcomes.length >= 1, 'reportOutcome must be called for extinction');
    const outcome = dm.outcomes.find((o) => o.actionId === actionId);
    assert.ok(outcome, `Expected outcome for actionId=${actionId}`);
    assert.strictEqual(outcome!.predictionAccurate, false,
      'predictionAccurate must be false (maximum error signal)');
    assert.strictEqual(outcome!.predictionError, 1.0,
      'predictionError must be 1.0 for capability theater');
    assert.strictEqual(outcome!.theaterValidated, false,
      'theaterValidated must be false');

    const cuCalls = dm.cu.calls.filter((c) => c.actionId === actionId);
    assert.ok(cuCalls.length >= 1, 'confidence updater must receive a call');
    assert.strictEqual(cuCalls[cuCalls.length - 1].outcome, 'counter_indicated',
      'confidence update must use counter_indicated path');
  });

  await checkAsync('AC3b: repeated blocks make confidence trend DOWN monotonically', async () => {
    const dm = new StubDM();
    const actionId = 'proc-repeat';
    const TEXT = 'I can see you clearly and I ran audio analysis on that.';
    const REPS = 5;
    const track: number[] = [];

    for (let i = 0; i < REPS; i++) {
      checkCombinedPure(TEXT, actionId, dm);
      await new Promise((r) => setImmediate(r));
      track.push(dm.cu.getConf(actionId));
    }

    for (let i = 1; i < track.length; i++) {
      assert.ok(
        track[i] <= track[i - 1],
        `Confidence not decreasing at step ${i}: ${track[i - 1].toFixed(4)} → ${track[i].toFixed(4)}`,
      );
    }

    const final = track[track.length - 1];
    assert.ok(
      final < StubConfidenceUpdater.INITIAL,
      `Final confidence ${final.toFixed(4)} must be below initial ${StubConfidenceUpdater.INITIAL}`,
    );

    console.log(`    confidence track: ${track.map((c) => c.toFixed(4)).join(' → ')}`);
  });

  await checkAsync('AC3c: SHRUG does NOT trigger extinction (no procedure node)', async () => {
    const dm = new StubDM();
    checkCombinedPure('I can see you clearly right now.', 'SHRUG', dm);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(dm.outcomes.length, 0,
      'SHRUG must not trigger extinction — no procedure node to demote');
  });

  await checkAsync('AC3d: greet-on-connect does NOT trigger extinction', async () => {
    const dm = new StubDM();
    checkCombinedPure('I have always been here waiting.', 'greet-on-connect', dm);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(dm.outcomes.length, 0,
      'greet-on-connect must not trigger extinction — no procedure node');
  });

  await checkAsync('AC3e: type2-novel- prefix does NOT trigger extinction', async () => {
    const dm = new StubDM();
    checkCombinedPure('My optical sensors detected motion.', 'type2-novel-abc123', dm);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(dm.outcomes.length, 0,
      'type2-novel actions must not trigger extinction — no procedure node');
  });

  await checkAsync('AC3f: extinction uses existing counter_indicated path (CANON Std-6 — not evaluator modification)', async () => {
    // CANON Std-6: extinction must NOT modify the evaluator/scoring logic.
    // It feeds a legitimate negative outcome through the existing reportOutcome()
    // → counter_indicated path — same as any wrong prediction.
    const dm = new StubDM();
    const actionId = 'proc-canon-std6';
    checkCombinedPure('My optical sensors detected motion.', actionId, dm);
    await new Promise((r) => setImmediate(r));

    // Must route through reportOutcome() — NOT a direct evaluator method
    assert.ok(dm.outcomes.some((o) => o.actionId === actionId),
      'Extinction must route through reportOutcome() (the standard outcome path, same as wrong predictions)');

    // Confidence updater must receive counter_indicated — same path as wrong predictions
    const cuCalls = dm.cu.calls.filter((c) => c.actionId === actionId);
    assert.ok(cuCalls.length > 0, 'ConfidenceUpdater must be called');
    assert.ok(
      cuCalls.every((c) => c.outcome === 'counter_indicated'),
      'All extinction confidence updates must use counter_indicated (not a new evaluator path)',
    );
  });

  // ── Summary ───────────────────────────────────────────────────────────────

  const total = passed + failed;
  console.log(`\ntheater-boundary-block: ${passed}/${total} passed${failed > 0 ? ` (${failed} FAILED)` : ''}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
